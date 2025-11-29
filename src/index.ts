import hnswlib from 'hnswlib-node';
import {Mutex, Semaphore} from 'async-mutex';
import {promises as fsp} from 'fs';
import * as path from 'path';

interface VectorDBConfig {
    dim: number;
    maxElements: number;
    autoCompaction?: boolean;  // Enable/disable auto-compaction
    compactionInterval?: number;  // Interval in ms (default: 1 hour)
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

interface HybridSearchResult extends SearchResult {
    vectorScore: number;
    textScore: number;
    combinedScore: number;
}

interface HybridSearchOptions {
    vectorWeight?: number;
    textWeight?: number;
    k?: number;
    metadataFilter?: Record<string, any>;
    rerank?: boolean;
}

interface BM25Params {
    k1?: number;  // Term frequency saturation (default: 1.5)
    b?: number;   // Length normalization (default: 0.75)
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
    // BM25 statistics
    docLengths: Map<number, number>;  // Document lengths for BM25
    avgDocLength: number;
    totalDocs: number;
}

export class VectorDB {
    private readonly dim: number;
    private readonly maxElements: number;
    private readonly namespaces = new Map<string, NamespaceData>();
    private compactionIntervalId: NodeJS.Timeout | null = null;
    private readonly bm25Params: Required<BM25Params> = {
        k1: 1.5,
        b: 0.75
    };

    constructor(config: VectorDBConfig) {
        this.dim = config.dim;
        this.maxElements = config.maxElements;

        // Only schedule compaction if enabled (default: false to avoid hanging)
        if (config.autoCompaction) {
            this.scheduleCompaction(config.compactionInterval);
        }
    }

    /**
     * Clean up resources and stop background tasks
     * Call this before your process exits
     */
    destroy(): void {
        if (this.compactionIntervalId) {
            clearInterval(this.compactionIntervalId);
            this.compactionIntervalId = null;
        }
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
                docLengths: new Map(),
                avgDocLength: 0,
                totalDocs: 0
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

    /**
     * Calculate document length (number of tokens) for BM25
     */
    private calculateDocLength(metadata: Record<string, any>, indexedFields: string[]): number {
        let length = 0;
        indexedFields.forEach(field => {
            const value = metadata[field];
            if (typeof value === 'string') {
                const tokens = this.tokenizeText(value);
                length += tokens.length;
            }
        });
        return length;
    }

    /**
     * Update BM25 statistics when documents are added/removed
     */
    private updateBM25Stats(nsData: NamespaceData): void {
        if (nsData.docLengths.size === 0) {
            nsData.avgDocLength = 0;
            nsData.totalDocs = 0;
            return;
        }

        let totalLength = 0;
        nsData.docLengths.forEach(length => {
            totalLength += length;
        });

        nsData.avgDocLength = totalLength / nsData.docLengths.size;
        nsData.totalDocs = nsData.docLengths.size;
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

        // Calculate and store document length for BM25
        const docLength = this.calculateDocLength(metadata, nsData.indexedFields);
        nsData.docLengths.set(internalId, docLength);

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

        // Update BM25 statistics
        this.updateBM25Stats(nsData);
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

    /**
     * Set BM25 parameters for tuning text search
     * @param k1 - Term frequency saturation parameter (default: 1.5, range: 1.2-2.0)
     * @param b - Length normalization parameter (default: 0.75, range: 0-1)
     */
    setBM25Params(k1: number = 1.5, b: number = 0.75): void {
        this.bm25Params.k1 = k1;
        this.bm25Params.b = b;
    }

    async insert(namespace: string, id: string, vector: number[], metadata: Record<string, any> = {}): Promise<void> {
        this.validateVector(vector);

        await this.withWriteLock(namespace, async (nsData) => {
            if (nsData.idMap[id] !== undefined) {
                throw new Error(`ID ${id} already exists`);
            }
            if (nsData.freeList.length === 0 && nsData.nextInternalId >= this.maxElements) {
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
                nsData.docLengths.delete(internalId);

                // Remove from full-text index
                nsData.fullTextIndex.forEach((ids, term) => {
                    if (ids.has(internalId)) {
                        ids.delete(internalId);
                        if (ids.size === 0) {
                            nsData.fullTextIndex.delete(term);
                        }
                    }
                });

                // Update BM25 statistics
                this.updateBM25Stats(nsData);
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

    /**
     * Calculate BM25 score for a document
     * @param termFreq - Map of term to its frequency in the document
     * @param docLength - Length of the document
     * @param nsData - Namespace data containing BM25 statistics
     * @returns BM25 score
     */
    private calculateBM25Score(
        termFreq: Map<string, number>,
        docLength: number,
        nsData: NamespaceData
    ): number {
        const { k1, b } = this.bm25Params;
        const N = nsData.totalDocs;
        let score = 0;

        termFreq.forEach((tf, term) => {
            const termDocs = nsData.fullTextIndex.get(term);
            if (!termDocs) return;

            const df = termDocs.size;  // Document frequency
            const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);  // IDF formula

            // BM25 formula
            const numerator = tf * (k1 + 1);
            const denominator = tf + k1 * (1 - b + b * (docLength / nsData.avgDocLength));

            score += idf * (numerator / denominator);
        });

        return score;
    }

    /**
     * Full-text search using BM25 scoring
     */
    async fullTextSearch(
        namespace: string,
        query: string,
        k: number = 5,
        metadataFilter: Record<string, any> = {}
    ): Promise<SearchResult[]> {
        return this.withReadLock(namespace, async (nsData) => {
            if (nsData.indexedFields.length === 0) return [];

            const queryTokens = this.tokenizeText(query);
            if (queryTokens.length === 0) return [];

            // Build term frequency for query
            const queryTermFreq = new Map<string, number>();
            queryTokens.forEach(token => {
                queryTermFreq.set(token, (queryTermFreq.get(token) || 0) + 1);
            });

            // Calculate BM25 scores for all matching documents
            const docScores = new Map<number, number>();

            queryTermFreq.forEach((_, term) => {
                const matchingDocs = nsData.fullTextIndex.get(term);
                if (!matchingDocs) return;

                matchingDocs.forEach(internalId => {
                    if (!docScores.has(internalId)) {
                        docScores.set(internalId, 0);
                    }
                });
            });

            // Calculate BM25 score for each matching document
            docScores.forEach((_, internalId) => {
                const entry = nsData.revMap.get(internalId);
                if (!entry) return;

                // Get document term frequencies
                const docTermFreq = new Map<string, number>();
                nsData.indexedFields.forEach(field => {
                    const value = entry.metadata[field];
                    if (typeof value === 'string') {
                        const tokens = this.tokenizeText(value);
                        tokens.forEach(token => {
                            if (queryTermFreq.has(token)) {
                                docTermFreq.set(token, (docTermFreq.get(token) || 0) + 1);
                            }
                        });
                    }
                });

                const docLength = nsData.docLengths.get(internalId) || 0;
                const bm25Score = this.calculateBM25Score(docTermFreq, docLength, nsData);
                docScores.set(internalId, bm25Score);
            });

            // Sort by BM25 score and apply filters
            return Array.from(docScores.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([internalId, score]) => {
                    const entry = nsData.revMap.get(internalId);
                    if (!entry) return null;

                    const matchesFilter = Object.entries(metadataFilter)
                        .every(([key, value]) => entry.metadata[key] === value);

                    return matchesFilter ? {
                        id: entry.publicId,
                        similarity: score,  // BM25 score (not normalized)
                        metadata: entry.metadata
                    } : null;
                })
                .filter(entry => entry !== null)
                .slice(0, k) as SearchResult[];
        });
    }

    /**
     * Perform hybrid search combining vector similarity and BM25 text search
     */
    async hybridSearch(
        namespace: string,
        queryVector: number[],
        queryText: string,
        options: HybridSearchOptions = {}
    ): Promise<HybridSearchResult[]> {
        const {
            vectorWeight = 0.5,
            textWeight = 0.5,
            k = 5,
            metadataFilter = {},
            rerank = false
        } = options;

        if (vectorWeight + textWeight !== 1.0) {
            throw new Error('vectorWeight and textWeight must sum to 1.0');
        }

        return this.withReadLock(namespace, async (nsData) => {
            if (nsData.revMap.size === 0) return [];

            const searchK = Math.min(k * 3, nsData.revMap.size);

            // Perform both searches
            const vectorResults = await this.performVectorSearch(
                nsData,
                queryVector,
                searchK,
                metadataFilter
            );

            const textResults = await this.performTextSearch(
                nsData,
                queryText,
                searchK,
                metadataFilter
            );

            // Combine results
            const combinedScores = this.combineSearchResults(
                vectorResults,
                textResults,
                vectorWeight,
                textWeight
            );

            let sortedResults = Array.from(combinedScores.values())
                .sort((a, b) => b.combinedScore - a.combinedScore);

            if (rerank) {
                sortedResults = this.rerankResults(sortedResults, queryVector, nsData);
            }

            return sortedResults.slice(0, k);
        });
    }

    /**
     * Reciprocal Rank Fusion (RRF) hybrid search
     */
    async hybridSearchRRF(
        namespace: string,
        queryVector: number[],
        queryText: string,
        k: number = 5,
        rrf_k: number = 60,
        metadataFilter: Record<string, any> = {}
    ): Promise<HybridSearchResult[]> {
        return this.withReadLock(namespace, async (nsData) => {
            if (nsData.revMap.size === 0) return [];

            const searchK = Math.min(k * 3, nsData.revMap.size);

            const vectorResults = await this.performVectorSearch(
                nsData,
                queryVector,
                searchK,
                metadataFilter
            );

            const textResults = await this.performTextSearch(
                nsData,
                queryText,
                searchK,
                metadataFilter
            );

            const rrfScores = new Map<string, {
                id: string;
                combinedScore: number;
                vectorScore: number;
                textScore: number;
                vectorRank: number;
                textRank: number;
                metadata: Record<string, any>;
            }>();

            vectorResults.forEach((result, rank) => {
                const rrfScore = 1 / (rrf_k + rank + 1);
                rrfScores.set(result.id, {
                    id: result.id,
                    combinedScore: rrfScore,
                    vectorScore: result.similarity,
                    textScore: 0,
                    vectorRank: rank + 1,
                    textRank: -1,
                    metadata: result.metadata
                });
            });

            textResults.forEach((result, rank) => {
                const rrfScore = 1 / (rrf_k + rank + 1);
                const existing = rrfScores.get(result.id);

                if (existing) {
                    existing.combinedScore += rrfScore;
                    existing.textScore = result.similarity;
                    existing.textRank = rank + 1;
                } else {
                    rrfScores.set(result.id, {
                        id: result.id,
                        combinedScore: rrfScore,
                        vectorScore: 0,
                        textScore: result.similarity,
                        vectorRank: -1,
                        textRank: rank + 1,
                        metadata: result.metadata
                    });
                }
            });

            return Array.from(rrfScores.values())
                .sort((a, b) => b.combinedScore - a.combinedScore)
                .slice(0, k)
                .map(result => ({
                    id: result.id,
                    similarity: result.combinedScore,
                    vectorScore: result.vectorScore,
                    textScore: result.textScore,
                    combinedScore: result.combinedScore,
                    metadata: result.metadata
                }));
        });
    }

    private async performVectorSearch(
        nsData: NamespaceData,
        queryVector: number[],
        k: number,
        metadataFilter: Record<string, any>
    ): Promise<SearchResult[]> {
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
    }

    private async performTextSearch(
        nsData: NamespaceData,
        queryText: string,
        k: number,
        metadataFilter: Record<string, any>
    ): Promise<SearchResult[]> {
        if (nsData.indexedFields.length === 0 || !queryText) return [];

        const queryTokens = this.tokenizeText(queryText);
        if (queryTokens.length === 0) return [];

        const queryTermFreq = new Map<string, number>();
        queryTokens.forEach(token => {
            queryTermFreq.set(token, (queryTermFreq.get(token) || 0) + 1);
        });

        const docScores = new Map<number, number>();

        queryTermFreq.forEach((_, term) => {
            const matchingDocs = nsData.fullTextIndex.get(term);
            if (!matchingDocs) return;
            matchingDocs.forEach(internalId => {
                if (!docScores.has(internalId)) {
                    docScores.set(internalId, 0);
                }
            });
        });

        docScores.forEach((_, internalId) => {
            const entry = nsData.revMap.get(internalId);
            if (!entry) return;

            const docTermFreq = new Map<string, number>();
            nsData.indexedFields.forEach(field => {
                const value = entry.metadata[field];
                if (typeof value === 'string') {
                    const tokens = this.tokenizeText(value);
                    tokens.forEach(token => {
                        if (queryTermFreq.has(token)) {
                            docTermFreq.set(token, (docTermFreq.get(token) || 0) + 1);
                        }
                    });
                }
            });

            const docLength = nsData.docLengths.get(internalId) || 0;
            const bm25Score = this.calculateBM25Score(docTermFreq, docLength, nsData);
            docScores.set(internalId, bm25Score);
        });

        return Array.from(docScores.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([internalId, score]) => {
                const entry = nsData.revMap.get(internalId);
                if (!entry) return null;

                const matchesFilter = Object.entries(metadataFilter)
                    .every(([key, value]) => entry.metadata[key] === value);

                return matchesFilter ? {
                    id: entry.publicId,
                    similarity: score,
                    metadata: entry.metadata
                } : null;
            })
            .filter(entry => entry !== null)
            .slice(0, k) as SearchResult[];
    }

    private combineSearchResults(
        vectorResults: SearchResult[],
        textResults: SearchResult[],
        vectorWeight: number,
        textWeight: number
    ): Map<string, HybridSearchResult> {
        const combinedScores = new Map<string, HybridSearchResult>();

        const normalizeScores = (results: SearchResult[]) => {
            if (results.length === 0) return [];
            const maxScore = Math.max(...results.map(r => r.similarity));
            const minScore = Math.min(...results.map(r => r.similarity));
            const range = maxScore - minScore || 1;

            return results.map(r => ({
                ...r,
                normalizedScore: (r.similarity - minScore) / range
            }));
        };

        const normalizedVector = normalizeScores(vectorResults);
        const normalizedText = normalizeScores(textResults);

        normalizedVector.forEach(result => {
            combinedScores.set(result.id, {
                id: result.id,
                similarity: result.similarity,
                vectorScore: result.normalizedScore,
                textScore: 0,
                combinedScore: result.normalizedScore * vectorWeight,
                metadata: result.metadata
            });
        });

        normalizedText.forEach(result => {
            const existing = combinedScores.get(result.id);
            if (existing) {
                existing.textScore = result.normalizedScore;
                existing.combinedScore += result.normalizedScore * textWeight;
            } else {
                combinedScores.set(result.id, {
                    id: result.id,
                    similarity: result.similarity,
                    vectorScore: 0,
                    textScore: result.normalizedScore,
                    combinedScore: result.normalizedScore * textWeight,
                    metadata: result.metadata
                });
            }
        });

        return combinedScores;
    }

    private rerankResults(
        results: HybridSearchResult[],
        queryVector: number[],
        nsData: NamespaceData
    ): HybridSearchResult[] {
        const lambda = 0.7;
        const reranked: HybridSearchResult[] = [];
        const remaining = [...results];

        if (remaining.length === 0) return [];

        reranked.push(remaining.shift()!);

        while (remaining.length > 0) {
            let maxScore = -Infinity;
            let maxIndex = -1;

            remaining.forEach((candidate, index) => {
                const candidateEntry = nsData.revMap.get(nsData.idMap[candidate.id]);
                if (!candidateEntry) return;

                let maxSimilarity = 0;
                for (const selected of reranked) {
                    const selectedEntry = nsData.revMap.get(nsData.idMap[selected.id]);
                    if (selectedEntry) {
                        const similarity = this.cosineSimilarity(
                            candidateEntry.vector,
                            selectedEntry.vector
                        );
                        maxSimilarity = Math.max(maxSimilarity, similarity);
                    }
                }

                const mmrScore = lambda * candidate.combinedScore - (1 - lambda) * maxSimilarity;

                if (mmrScore > maxScore) {
                    maxScore = mmrScore;
                    maxIndex = index;
                }
            });

            if (maxIndex >= 0) {
                reranked.push(remaining.splice(maxIndex, 1)[0]);
            } else {
                break;
            }
        }

        return reranked;
    }

    private cosineSimilarity(vec1: number[], vec2: number[]): number {
        let dotProduct = 0;
        let norm1 = 0;
        let norm2 = 0;

        for (let i = 0; i < vec1.length; i++) {
            dotProduct += vec1[i] * vec2[i];
            norm1 += vec1[i] * vec1[i];
            norm2 += vec2[i] * vec2[i];
        }

        return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
    }

    async save(namespace: string, filePath: string): Promise<void> {
        await this.withWriteLock(namespace, async (nsData) => {
            const dir = path.dirname(filePath);
            await fsp.mkdir(dir, { recursive: true });

            const payload = {
                idMap: nsData.idMap,
                revMap: Array.from(nsData.revMap.entries()),
                nextInternalId: nsData.nextInternalId,
                freeList: nsData.freeList,
                fullTextIndex: Array.from(nsData.fullTextIndex.entries()).map(
                    ([term, ids]) => [term, Array.from(ids)]
                ),
                indexedFields: nsData.indexedFields,
                docLengths: Array.from(nsData.docLengths.entries()),
                avgDocLength: nsData.avgDocLength,
                totalDocs: nsData.totalDocs
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
            nsData.docLengths = new Map(data.docLengths || []);
            nsData.avgDocLength = data.avgDocLength || 0;
            nsData.totalDocs = data.totalDocs || 0;
        });
    }

    private scheduleCompaction(interval: number = 60 * 60 * 1000): void {
        this.compactionIntervalId = setInterval(() => {
            this.namespaces.forEach((_, namespace) => {
                this.compactNamespace(namespace);
            });
        }, interval);

        // Allow the interval to not prevent process exit
        if (this.compactionIntervalId.unref) {
            this.compactionIntervalId.unref();
        }
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
        const newDocLengths = new Map<number, number>();

        for (const [publicId, internalId] of Object.entries(nsData.idMap)) {
            const entry = nsData.revMap.get(internalId);
            if (entry) {
                newIndex.addPoint(entry.vector, newNextId);
                newIdMap[publicId] = newNextId;
                newRevMap.set(newNextId, entry);

                // Reindex for full-text search
                const docLength = this.calculateDocLength(entry.metadata, nsData.indexedFields);
                newDocLengths.set(newNextId, docLength);

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
        nsData.docLengths = newDocLengths;

        // Recalculate BM25 stats
        this.updateBM25Stats(nsData);
    }
}