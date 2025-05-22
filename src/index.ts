import hnswlib from 'hnswlib-node';
import { Mutex, Semaphore, SemaphoreInterface, MutexInterface, E_CANCELED } from 'async-mutex';
import { promises as fsp } from 'fs';
import * as path from 'path';

interface VectorDBConfig {
    dim: number;
    maxElements: number;
}

interface VectorEntry {
    id: string;
    vector: number[];
    metadata?: Record<string, any>;
}

interface SearchResult {
    id: string;
    similarity: number;
    metadata: Record<string, any>;
}

interface NamespaceData {
    index: hnswlib.HierarchicalNSW;
    nextInternalId: number;
    idMap: Record<string, number>;
    revMap: Map<number, { publicId: string; vector: number[]; metadata: Record<string, any> }>;
    readSemaphore: Semaphore;
    writeMutex: Mutex;
    readerCount: number;
    freeList: number[];
    fullTextIndex: Map<string, Set<number>>;
    indexedFields: string[];
}

export class VectorDB {
    private readonly dim: number;
    private readonly maxElements: number;
    private readonly namespaces = new Map<string, NamespaceData>();

    constructor(config: VectorDBConfig) {
        this.dim = config.dim;
        this.maxElements = config.maxElements;
        this.scheduleCompaction();
    }

    private initializeNamespace(namespace: string): void {
        if (!this.namespaces.has(namespace)) {
            const index = new hnswlib.HierarchicalNSW('cosine', this.dim);
            index.initIndex(this.maxElements);
            
            this.namespaces.set(namespace, {
                index,
                nextInternalId: 0,
                idMap: {},
                revMap: new Map(),
                readSemaphore: new Semaphore(1),
                writeMutex: new Mutex(),
                readerCount: 0,
                freeList: [],
                fullTextIndex: new Map(),
                indexedFields: [],
            });
        }
    }

    private validateVector(vector: number[]): void {
        if (vector.length !== this.dim) {
            throw new Error(`Vector dimension mismatch. Expected ${this.dim}, got ${vector.length}`);
        }
    }

    private tokenizeText(text: string): string[] {
        return text
            .toLowerCase()
            .split(/[\s\W]+/)
            .filter(token => token.length > 0);
    }

    private indexMetadata(nsData: NamespaceData, internalId: number, metadata: Record<string, any>): void {
        // Remove existing entries for this internalId
        nsData.fullTextIndex.forEach((ids, term) => {
            if (ids.has(internalId)) {
                ids.delete(internalId);
                if (ids.size === 0) {
                    nsData.fullTextIndex.delete(term);
                }
            }
        });

        // Index new metadata
        nsData.indexedFields.forEach(field => {
            const value = metadata[field];
            if (typeof value === 'string') {
                const tokens = this.tokenizeText(value);
                tokens.forEach(token => {
                    if (!nsData.fullTextIndex.has(token)) {
                        nsData.fullTextIndex.set(token, new Set());
                    }
                    nsData.fullTextIndex.get(token)!.add(internalId);
                });
            }
        });
    }

    private async withReadLock<T>(namespace: string, operation: (nsData: NamespaceData) => Promise<T>): Promise<T> {
        this.initializeNamespace(namespace);
        const nsData = this.namespaces.get(namespace)!;

        const [ , readSemRelease ] = await nsData.readSemaphore.acquire();
        try {
            nsData.readerCount++;
            if (nsData.readerCount === 1) {
                await nsData.writeMutex.acquire();
            }
        } finally {
            readSemRelease();
        }

        try {
            return await operation(nsData);
        } finally {
            const [ , readSemReleaseAgain ] = await nsData.readSemaphore.acquire();
            try {
                nsData.readerCount--;
                if (nsData.readerCount === 0) {
                    nsData.writeMutex.release();
                }
            } finally {
                readSemReleaseAgain();
            }
        }
    }

    private async withWriteLock<T>(namespace: string, operation: (nsData: NamespaceData) => Promise<T>): Promise<T> {
        this.initializeNamespace(namespace);
        const nsData = this.namespaces.get(namespace)!;

        const writeMutexRelease = await nsData.writeMutex.acquire();
        try {
            return await operation(nsData);
        } finally {
            writeMutexRelease();
        }
    }

    async setFullTextIndexedFields(namespace: string, fields: string[]): Promise<void> {
        await this.withWriteLock(namespace, async (nsData) => {
            nsData.indexedFields = fields;
        });
    }

    async insert(namespace: string, id: string, vector: number[], metadata: Record<string, any> = {}): Promise<void> {
        this.validateVector(vector);
        
        await this.withWriteLock(namespace, async (nsData) => {
            if (nsData.idMap[id] !== undefined) {
                throw new Error(`ID ${id} already exists`);
            }
            if (nsData.freeList.length === 0 && nsData.nextInternalId >= this.maxElements) {
                // TODO handle more gently
                throw new Error('Max capacity reached');
            }

            const internalId = nsData.freeList.pop() ?? nsData.nextInternalId++;
            nsData.idMap[id] = internalId;
            nsData.revMap.set(internalId, { publicId: id, vector, metadata });
            this.indexMetadata(nsData, internalId, metadata);
            nsData.index.addPoint(vector, internalId);
        });
    }

    async batchInsert(namespace: string, entries: VectorEntry[]): Promise<void> {
        await this.withWriteLock(namespace, async (nsData) => {
            for (const { id } of entries) {
                if (nsData.idMap[id] !== undefined) {
                    throw new Error(`Duplicate ID: ${id}`);
                }
            }

            for (const { id, vector, metadata = {} } of entries) {
                this.validateVector(vector);
                
                const internalId = nsData.freeList.pop() ?? nsData.nextInternalId++;
                nsData.idMap[id] = internalId;
                nsData.revMap.set(internalId, { publicId: id, vector, metadata });
                this.indexMetadata(nsData, internalId, metadata);
                nsData.index.addPoint(vector, internalId);
            }
        });
    }

    async update(namespace: string, id: string, newVector: number[], newMetadata?: Record<string, any>): Promise<void> {
        this.validateVector(newVector);
        
        await this.withWriteLock(namespace, async (nsData) => {
            const internalId = nsData.idMap[id];
            if (internalId === undefined) {
                throw new Error(`ID ${id} not found`);
            }

            const entry = nsData.revMap.get(internalId)!;
            nsData.index.markDelete(internalId);
            nsData.index.addPoint(newVector, internalId);
            
            const mergedMetadata = newMetadata ?? entry.metadata;
            nsData.revMap.set(internalId, { 
                ...entry, 
                vector: newVector,
                metadata: mergedMetadata
            });
            this.indexMetadata(nsData, internalId, mergedMetadata);
        });
    }

    async delete(namespace: string, id: string): Promise<void> {
        await this.withWriteLock(namespace, async (nsData) => {
            const internalId = nsData.idMap[id];
            if (internalId !== undefined) {
                nsData.index.markDelete(internalId);
                delete nsData.idMap[id];
                nsData.revMap.delete(internalId);
                nsData.freeList.push(internalId);
                
                // Remove from full-text index
                nsData.fullTextIndex.forEach((ids, term) => {
                    if (ids.has(internalId)) {
                        ids.delete(internalId);
                        if (ids.size === 0) {
                            nsData.fullTextIndex.delete(term);
                        }
                    }
                });
            }
        });
    }

    async search(
        namespace: string,
        queryVector: number[],
        k: number = 5,
        metadataFilter: Record<string, any> = {}
    ): Promise<SearchResult[]> {
        return this.withReadLock(namespace, async (nsData) => {
            const actualSize = nsData.revMap.size;
            if (actualSize === 0) return [];
            
            const result = nsData.index.searchKnn(queryVector, Math.min(k * 2, actualSize));
            
            return result.neighbors
                .map((internalId, index) => {
                    const entry = nsData.revMap.get(internalId);
                    if (!entry) return null;
                    
                    return {
                        id: entry.publicId,
                        similarity: 1 - result.distances[index],
                        metadata: entry.metadata
                    };
                })
                .filter(entry => entry && 
                    Object.entries(metadataFilter).every(([key, value]) => 
                        entry!.metadata[key] === value
                    )
                )
                .slice(0, k) as SearchResult[];
        });
    }

    async fullTextSearch(
        namespace: string,
        query: string,
        k: number = 5,
        metadataFilter: Record<string, any> = {}
    ): Promise<SearchResult[]> {
        return this.withReadLock(namespace, async (nsData) => {
            if (nsData.indexedFields.length === 0) return [];
            
            const tokens = this.tokenizeText(query);
            if (tokens.length === 0) return [];
            
            const internalIds = new Map<number, number>();
            tokens.forEach(token => {
                const ids = nsData.fullTextIndex.get(token);
                ids?.forEach(id => {
                    internalIds.set(id, (internalIds.get(id) || 0) + 1);
                });
            });

            const sortedEntries = Array.from(internalIds.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([internalId]) => {
                    const entry = nsData.revMap.get(internalId);
                    if (!entry) return null;
                    
                    const matchesFilter = Object.entries(metadataFilter)
                        .every(([key, value]) => entry.metadata[key] === value);
                    
                    return matchesFilter ? {
                        id: entry.publicId,
                        similarity: internalIds.get(internalId)! / tokens.length,
                        metadata: entry.metadata
                    } : null;
                })
                .filter(entry => entry !== null)
                .slice(0, k) as SearchResult[];

            return sortedEntries;
        });
    }

    async save(namespace: string, filePath: string): Promise<void> {
        await this.withWriteLock(namespace, async (nsData) => {
            const dir = path.dirname(filePath);
    
            // Ensure the directory exists
            await fsp.mkdir(dir, { recursive: true });
    
            const payload = {
                idMap: nsData.idMap,
                revMap: Array.from(nsData.revMap.entries()),
                nextInternalId: nsData.nextInternalId,
                freeList: nsData.freeList,
                fullTextIndex: Array.from(nsData.fullTextIndex.entries()).map(
                    ([term, ids]) => [term, Array.from(ids)]
                ),
                indexedFields: nsData.indexedFields
            };
    
            await Promise.all([
                nsData.index.writeIndex(`${filePath}.idx`),
                fsp.writeFile(`${filePath}.meta.json`, JSON.stringify(payload))
            ]);
        });
    }

    async load(namespace: string, filePath: string): Promise<void> {
        await this.withWriteLock(namespace, async (nsData) => {
            const [_, payload] = await Promise.all([
                nsData.index.readIndex(`${filePath}.idx`),
                fsp.readFile(`${filePath}.meta.json`, 'utf-8')
            ]);

            const data = JSON.parse(payload);
            nsData.idMap = data.idMap;
            nsData.revMap = new Map(data.revMap);
            nsData.nextInternalId = data.nextInternalId;
            nsData.freeList = data.freeList;
            nsData.fullTextIndex = new Map(
                (data.fullTextIndex || []).map(([term, ids]: [string, number[]]) => [term, new Set(ids)])
            );
            nsData.indexedFields = data.indexedFields || [];
        });
    }

    private scheduleCompaction(): void {
        setInterval(() => {
            this.namespaces.forEach((_, namespace) => {
                this.compactNamespace(namespace);
            });
        }, 60 * 60 * 1000);
    }

    private compactNamespace(namespace: string): void {
        const nsData = this.namespaces.get(namespace);
        if (!nsData) return;

        const newIndex = new hnswlib.HierarchicalNSW('cosine', this.dim);
        newIndex.initIndex(this.maxElements);

        let newNextId = 0;
        const newIdMap: Record<string, number> = {};
        const newRevMap = new Map<number, { publicId: string; vector: number[]; metadata: Record<string, any> }>();
        const newFullTextIndex = new Map<string, Set<number>>();

        for (const [publicId, internalId] of Object.entries(nsData.idMap)) {
            const entry = nsData.revMap.get(internalId);
            if (entry) {
                newIndex.addPoint(entry.vector, newNextId);
                newIdMap[publicId] = newNextId;
                newRevMap.set(newNextId, entry);
                
                // Reindex metadata for full-text search
                nsData.indexedFields.forEach(field => {
                    const value = entry.metadata[field];
                    if (typeof value === 'string') {
                        const tokens = this.tokenizeText(value);
                        tokens.forEach(token => {
                            if (!newFullTextIndex.has(token)) {
                                newFullTextIndex.set(token, new Set());
                            }
                            newFullTextIndex.get(token)!.add(newNextId);
                        });
                    }
                });
                
                newNextId++;
            }
        }

        nsData.index = newIndex;
        nsData.nextInternalId = newNextId;
        nsData.idMap = newIdMap;
        nsData.revMap = newRevMap;
        nsData.freeList = [];
        nsData.fullTextIndex = newFullTextIndex;
    }
}