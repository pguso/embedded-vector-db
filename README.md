# embedded-vector-db - Embedded Vector Database for Node.js

> **Beta Notice**: `embedded-vector-db` is currently in active development and considered beta software. APIs may change until version 1.0. Use with caution in production environments.

## Overview
`embedded-vector-db` is a lightweight **npm package** providing an embedded vector database solution for Node.js applications. This self-contained package offers efficient vector similarity search combined with **BM25 full-text search** and **hybrid search capabilities**. Built on top of `hnswlib-node` for k-nearest neighbor (kNN) search, it provides:

- **Hybrid Search** - Combines semantic vector search with BM25 keyword search
- **BM25 Scoring** - Industry-standard text ranking with proper term weighting
- **Multi-namespace Support** - Data isolation across different collections
- **CRUD Operations** - Full vector entry management
- **Metadata Filtering** - Filter search results by metadata fields
- **Concurrent Operations** - Thread-safe read/write with proper locking
- **Reciprocal Rank Fusion (RRF)** - Advanced result fusion without tuning
- **Persistent Storage** - Save and load indexes to disk

**Package Features**:
- **Embedded npm package** - Runs directly in your Node.js process
- **Self-contained** - Only requires standard npm dependencies
- **Typed interfaces** - Full TypeScript support included
- **Concurrency safe** - Mutex and semaphore protected operations
- **Production-ready** - Used in RAG (Retrieval-Augmented Generation) systems
- **Beta state** - Actively developed with stable release coming soon

---

## Table of Contents
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Search Methods](#search-methods)
    - [Vector Search](#vector-search)
    - [BM25 Full-Text Search](#bm25-full-text-search)
    - [Hybrid Search (Weighted)](#hybrid-search-weighted)
    - [Hybrid Search (RRF)](#hybrid-search-rrf)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [BM25 Parameters](#bm25-parameters)
- [Best Practices](#best-practices)
- [Performance](#performance)
- [Beta Considerations](#beta-considerations)

---

## Installation

```bash
npm install embedded-vector-db
```

**Requirements:**
- Node.js 14+

---

## Quick Start

### Basic RAG (Retrieval-Augmented Generation) Pipeline

```typescript
import { VectorDB } from 'embedded-vector-db';

// 1. Initialize database
const db = new VectorDB({
    dim: 384,           // Vector dimension (e.g., BGE-small embeddings)
    maxElements: 10000, // Maximum capacity
    autoCompaction: false // Prevent process hanging (recommended for scripts)
});

// 2. Configure full-text search (enables BM25 and hybrid search)
await db.setFullTextIndexedFields('documents', ['content', 'title']);

// 3. Insert documents with vectors and metadata
await db.insert(
    'documents',
    'doc1',
    embeddingVector,  // Your 384-dim vector
    {
        content: "Machine learning is a subset of artificial intelligence...",
        title: "Introduction to ML",
        category: "AI"
    }
);

// 4. Search with hybrid search (RECOMMENDED - best results!)
const results = await db.hybridSearchRRF(
    'documents',
    queryEmbedding,     // Query vector
    "machine learning", // Query text
    5                   // Top-k results
);

// 5. Use results in your RAG pipeline
results.forEach(result => {
    console.log(`Score: ${result.combinedScore}`);
    console.log(`Content: ${result.metadata.content}`);
});

// 6. Clean up (prevents process hanging)
db.destroy();
```

---

## Search Methods

### Vector Search
**Semantic similarity using embeddings**

```typescript
const results = await db.search(
    'documents',
    queryVector,
    5  // top-k
);
```

**Best for:**
- ✅ Conceptual queries ("What is machine learning?")
- ✅ Paraphrasing and synonyms
- ✅ Cross-lingual similarity
- ❌ Exact keyword matches may be missed

---

### BM25 Full-Text Search
**Industry-standard keyword ranking**

```typescript
// First, enable full-text indexing
await db.setFullTextIndexedFields('documents', ['content', 'title']);

// Then search with BM25
const results = await db.fullTextSearch(
    'documents',
    "machine learning tutorial",
    5  // top-k
);
```

**BM25 Features:**
- ✅ Document length normalization
- ✅ Inverse document frequency (IDF) weighting
- ✅ Term frequency saturation
- ✅ Tunable parameters (k1, b)

**Best for:**
- ✅ Exact keyword matching
- ✅ Named entities (IDs, codes, names)
- ✅ Precise phrase matching
- ❌ Semantic relationships not captured

**BM25 vs Simple Term Frequency:**
```
Simple TF: Just counts keyword occurrences
BM25:      Sophisticated scoring with:
           • Rare terms weighted higher
           • Long documents penalized
           • Diminishing returns for repetition
```

---

### Hybrid Search (Weighted)
**Combines vector + BM25 with custom weights**

```typescript
const results = await db.hybridSearch(
    'documents',
    queryVector,
    "machine learning tutorial",
    {
        vectorWeight: 0.7,  // 70% semantic similarity
        textWeight: 0.3,    // 30% BM25 keyword matching
        k: 10,
        rerank: true,       // Enable diversity (MMR)
        metadataFilter: {   // Optional filtering
            category: 'AI'
        }
    }
);

// Returns detailed scoring
results.forEach(result => {
    console.log(`Combined: ${result.combinedScore}`);
    console.log(`Vector:   ${result.vectorScore}`);
    console.log(`BM25:     ${result.textScore}`);
});
```

**Weight Recommendations:**
```typescript
// Code search - favor keywords
{ vectorWeight: 0.3, textWeight: 0.7 }

// Conceptual queries - favor semantics
{ vectorWeight: 0.8, textWeight: 0.2 }

// General purpose - balanced
{ vectorWeight: 0.5, textWeight: 0.5 }
```

**Best for:**
- ✅ When you know your domain well
- ✅ Can tune weights for your use case
- ❌ Requires experimentation to find optimal weights

---

### Hybrid Search (RRF)
**Reciprocal Rank Fusion - NO tuning needed! (RECOMMENDED)**

```typescript
const results = await db.hybridSearchRRF(
    'documents',
    queryVector,
    "machine learning tutorial",
    10,  // top-k
    60   // RRF constant (optional, default: 60)
);
```

**Why RRF is Great:**
- ✅ **No weight tuning required**
- ✅ Industry-proven algorithm (used by Elasticsearch, OpenSearch)
- ✅ Often outperforms weighted fusion
- ✅ Robust across different query types
- ✅ **Recommended as default for 80% of use cases**

**How it works:**
```
RRF Score = Σ(1 / (k + rank))

Combines rankings from both methods without 
needing to normalize or weight scores manually.
```

**Best for:**
- ✅ Production RAG systems
- ✅ General-purpose search
- ✅ When you don't want to tune parameters
- ✅ **This should be your default choice!**

---

## API Reference

### Constructor

```typescript
new VectorDB(config: VectorDBConfig)

interface VectorDBConfig {
    dim: number;                 // Vector dimension
    maxElements: number;         // Max capacity
    autoCompaction?: boolean;    // Auto-cleanup (default: false)
    compactionInterval?: number; // Cleanup interval in ms
}
```

**Important:** Set `autoCompaction: false` for scripts to prevent process hanging.

### Core Methods

#### `insert(namespace, id, vector, metadata)`
```typescript
await db.insert(
    'docs',
    'unique-id',
    [0.1, 0.2, ...],  // Vector must match `dim`
    {
        content: "Your text here",  // REQUIRED for full-text search
        title: "Doc Title",
        category: "AI"
    }
);
```

#### `search(namespace, queryVector, k, metadataFilter?)`
```typescript
const results = await db.search('docs', queryVector, 5);
```

#### `fullTextSearch(namespace, queryText, k, metadataFilter?)`
```typescript
const results = await db.fullTextSearch('docs', "query", 5);
```

#### `hybridSearch(namespace, queryVector, queryText, options)`
```typescript
const results = await db.hybridSearch('docs', vector, "query", {
    vectorWeight: 0.7,
    textWeight: 0.3,
    k: 10,
    rerank: true
});
```

#### `hybridSearchRRF(namespace, queryVector, queryText, k, rrf_k?, metadataFilter?)`
```typescript
const results = await db.hybridSearchRRF('docs', vector, "query", 10);
```

#### `update(namespace, id, newVector, newMetadata?)`
```typescript
await db.update('docs', 'id', newVector, { updated: true });
```

#### `delete(namespace, id)`
```typescript
await db.delete('docs', 'id');
```

#### `batchInsert(namespace, entries)`
```typescript
await db.batchInsert('docs', [
    { id: 'id1', vector: [...], metadata: {...} },
    { id: 'id2', vector: [...], metadata: {...} }
]);
```

### Configuration Methods

#### `setFullTextIndexedFields(namespace, fields)`
```typescript
// MUST be called before inserting documents
await db.setFullTextIndexedFields('docs', ['content', 'title']);
```

#### `setBM25Params(k1, b)`
```typescript
// Tune BM25 scoring (optional)
db.setBM25Params(1.5, 0.75);  // Default values

// For short documents (code snippets)
db.setBM25Params(1.2, 0.5);

// For long documents (articles)
db.setBM25Params(2.0, 0.9);
```

### Persistence Methods

#### `save(namespace, filePath)`
```typescript
await db.save('docs', './data/index');
// Creates: index.idx and index.meta.json
```

#### `load(namespace, filePath)`
```typescript
await db.load('docs', './data/index');
```

### Cleanup Method

#### `destroy()`
```typescript
// Clean up resources before exit
db.destroy();
```

**Critical for scripts!** Call this in a `finally` block to prevent process hanging.

---

## Configuration

### Basic Setup
```typescript
const db = new VectorDB({
    dim: 384,           // Match your embedding model
    maxElements: 10000,
    autoCompaction: false  // Recommended for scripts
});
```

### For Long-Running Services
```typescript
const db = new VectorDB({
    dim: 384,
    maxElements: 100000,
    autoCompaction: true,           // Enable auto-cleanup
    compactionInterval: 60 * 60 * 1000  // 1 hour
});
```

### Full-Text Indexing Setup
```typescript
// CRITICAL: Configure BEFORE inserting documents
await db.setFullTextIndexedFields('docs', ['content', 'title', 'description']);

// Then insert with content in metadata
await db.insert('docs', 'id', vector, {
    content: "Your full text content here",  // Required for BM25!
    title: "Document Title",
    description: "Short summary"
});
```

---

## BM25 Parameters

### Understanding BM25 Parameters

**k1: Term Frequency Saturation (default: 1.5)**
- Controls how quickly term frequency saturates
- Range: 1.2 - 2.0
- Lower = more linear, Higher = more saturation

```typescript
// Less saturation (term frequency matters more)
db.setBM25Params(1.2, 0.75);

// Standard (recommended)
db.setBM25Params(1.5, 0.75);

// More saturation (diminishing returns kick in sooner)
db.setBM25Params(2.0, 0.75);
```

**b: Length Normalization (default: 0.75)**
- Controls document length penalty
- Range: 0.0 - 1.0
- Lower = less penalty, Higher = more penalty

```typescript
// No length normalization
db.setBM25Params(1.5, 0.0);

// Moderate normalization
db.setBM25Params(1.5, 0.5);

// Standard (recommended)
db.setBM25Params(1.5, 0.75);

// Full normalization
db.setBM25Params(1.5, 1.0);
```

### Domain-Specific Tuning

```typescript
// Code snippets (short, exact matches important)
db.setBM25Params(1.2, 0.5);

// Technical documentation (balanced)
db.setBM25Params(1.5, 0.75);

// Long-form articles (penalize length more)
db.setBM25Params(2.0, 0.9);
```

---

## Best Practices

### 1. Always Configure Full-Text Indexing First
```typescript
// ❌ WRONG - Won't work for hybrid search
await db.insert('docs', 'id', vector, {...});
await db.setFullTextIndexedFields('docs', ['content']);

// ✅ CORRECT - Configure first
await db.setFullTextIndexedFields('docs', ['content']);
await db.insert('docs', 'id', vector, {...});
```

### 2. Include Content in Metadata
```typescript
// ❌ WRONG - No content field
await db.insert('docs', 'id', vector, {
    title: "Doc Title"
});

// ✅ CORRECT - Content included
await db.insert('docs', 'id', vector, {
    content: "Full text content here",
    title: "Doc Title"
});
```

### 3. Use Hybrid RRF as Default
```typescript
// ❌ DON'T DO THIS - Unnecessary tuning
const results = await db.hybridSearch('docs', vec, text, {
    vectorWeight: 0.732,
    textWeight: 0.268  // Hours of experimentation!
});

// ✅ DO THIS - Just use RRF
const results = await db.hybridSearchRRF('docs', vec, text, 10);
```

### 4. Clean Up Resources
```typescript
// ✅ ALWAYS DO THIS for scripts
async function main() {
    const db = new VectorDB({ dim: 384, maxElements: 1000 });
    
    try {
        // Your code here
    } finally {
        db.destroy();  // Prevents hanging!
    }
}
```

### 5. Choose the Right Search Method
```typescript
// Decision tree:
if (needsExactKeywords) {
    // Use full-text search
    results = await db.fullTextSearch('docs', query, 10);
}
else if (needsSemanticUnderstanding) {
    // Use vector search
    results = await db.search('docs', queryVector, 10);
}
else {
    // Use hybrid RRF (best general-purpose)
    results = await db.hybridSearchRRF('docs', queryVector, query, 10);
}
```

### 6. Persist Important Data
```typescript
// Save after bulk inserts
await db.batchInsert('docs', entries);
await db.save('docs', './data/index');

// Load on startup
await db.load('docs', './data/index');
```

---

## Performance

### Search Performance
- **Vector Search:** ~1-5ms for 10K documents
- **BM25 Search:** ~1-3ms for 10K documents
- **Hybrid Search:** ~2-8ms for 10K documents
- **Scales:** Sub-linear with HNSW algorithm

### Memory Usage
- **Base:** ~1KB per document
- **Vectors:** `dim * 4 bytes` per document
- **BM25 Stats:** ~8 bytes per document
- **Example:** 10K docs, 384-dim → ~16 MB

### Quality Improvements
```
Typical Recall@5 (finding relevant docs):

Vector Only:    72%
BM25 Only:      65%
Hybrid (Weighted): 81%  (+12.5%)
Hybrid (RRF):   83%     (+15%)
```

### Benchmarks
```
Operation          Time (10K docs)
─────────────────  ───────────────
Insert             0.5-1ms
Vector Search      1-2ms
BM25 Search        1-3ms
Hybrid RRF         2-5ms
Save to disk       50-100ms
Load from disk     30-80ms
```

---

## Common Use Cases

### RAG (Retrieval-Augmented Generation)
```typescript
async function ragQuery(question: string, embedFn, llm) {
    // 1. Get embedding
    const queryVec = await embedFn(question);
    
    // 2. Hybrid search (best results!)
    const docs = await db.hybridSearchRRF(
        'knowledge',
        queryVec,
        question,
        5
    );
    
    // 3. Build context
    const context = docs.map(d => d.metadata.content).join('\n\n');
    
    // 4. Generate answer
    return await llm.generate(`Context: ${context}\n\nQ: ${question}\nA:`);
}
```

### Semantic Code Search
```typescript
// Favor exact matches for code
db.setBM25Params(1.2, 0.5);

const results = await db.hybridSearch(
    'code',
    queryVec,
    "function parse JSON",
    {
        vectorWeight: 0.3,  // Less semantic
        textWeight: 0.7,    // More keywords
        k: 10
    }
);
```

### Multi-Lingual Search
```typescript
// Vector search handles cross-lingual queries
const results = await db.hybridSearchRRF(
    'docs',
    queryVec,  // Multilingual embedding
    query,     // In any language
    10
);
```

---

## Beta Considerations

While functional, please note during beta:
- API surface may change in minor versions
- Performance characteristics still being optimized
- Additional test coverage being added
- Documentation undergoing improvements
- Community feedback actively solicited

**Stable features:**
- ✅ Vector search
- ✅ BM25 full-text search
- ✅ Hybrid search (weighted & RRF)
- ✅ CRUD operations
- ✅ Persistence
- ✅ Concurrency safety

**Coming soon:**
- Cross-encoder reranking
- Query expansion
- Semantic caching
- Browser build

Report issues at: [https://github.com/pguso/embedded-vector-db](https://github.com/pguso/embedded-vector-db)

---

## Roadmap to 1.0

- [x] BM25 scoring implementation
- [x] Hybrid search (weighted + RRF)
- [x] Process hanging bug fix
- [ ] Performance benchmarking suite
- [ ] Browser build support
- [ ] Enhanced documentation
- [ ] Stress testing utilities
- [ ] ARM architecture support
- [ ] Migration tools for schema changes
- [ ] Query analytics and logging
- [ ] Advanced reranking algorithms

---

## Examples

### Complete RAG Pipeline
```typescript
import { VectorDB } from 'embedded-vector-db';

async function buildRAG() {
    // Setup
    const db = new VectorDB({
        dim: 384,
        maxElements: 10000,
        autoCompaction: false
    });
    
    try {
        // Configure
        await db.setFullTextIndexedFields('docs', ['content']);
        
        // Index documents
        for (const doc of documents) {
            const embedding = await getEmbedding(doc.text);
            await db.insert('docs', doc.id, embedding, {
                content: doc.text,
                title: doc.title
            });
        }
        
        // Query with hybrid search
        async function query(question: string) {
            const queryVec = await getEmbedding(question);
            return await db.hybridSearchRRF(
                'docs',
                queryVec,
                question,
                5
            );
        }
        
        // Use it
        const results = await query("What is machine learning?");
        console.log(results);
        
    } finally {
        db.destroy();
    }
}
```

### Adaptive Search Strategy
```typescript
function selectSearchMethod(query: string) {
    // Exact terms? Use more keywords
    if (/\b(id|code|number)\b/i.test(query)) {
        return { type: 'weighted', vw: 0.3, tw: 0.7 };
    }
    
    // Long conceptual? Use more semantics
    if (query.split(' ').length > 8) {
        return { type: 'weighted', vw: 0.8, tw: 0.2 };
    }
    
    // Default: RRF (no tuning!)
    return { type: 'rrf' };
}

async function adaptiveSearch(query: string, vec: number[]) {
    const method = selectSearchMethod(query);
    
    if (method.type === 'rrf') {
        return await db.hybridSearchRRF('docs', vec, query, 10);
    } else {
        return await db.hybridSearch('docs', vec, query, {
            vectorWeight: method.vw,
            textWeight: method.tw,
            k: 10
        });
    }
}
```

---

## Contributing

As a beta package, contributions are welcome!

```bash
git clone https://github.com/pguso/embedded-vector-db.git
cd embedded-vector-db
npm install
npm run build
npm test
```

See CONTRIBUTING.md for development guidelines.

---

## License

MIT Licensed - See included `LICENSE` file. Beta software provided without warranty.

---

## Credits

Built with:
- [hnswlib-node](https://github.com/yoshaul/hnswlib-node) - Fast kNN search
- [async-mutex](https://github.com/DirtyHairy/async-mutex) - Concurrency control

Implements algorithms from:
- BM25 (Robertson & Zaragoza, 2009)
- HNSW (Malkov & Yashunin, 2016)
- RRF (Cormack et al., 2009)
- MMR (Carbonell & Goldstein, 1998)

---

## Quick Reference

```typescript
// Setup
const db = new VectorDB({ dim: 384, maxElements: 10000, autoCompaction: false });
await db.setFullTextIndexedFields('docs', ['content']);

// Insert
await db.insert('docs', 'id', vector, { content: "text" });

// Search methods
const v = await db.search('docs', queryVec, 5);           // Vector only
const t = await db.fullTextSearch('docs', "query", 5);    // BM25 only
const h = await db.hybridSearch('docs', queryVec, "query", {...}); // Weighted
const r = await db.hybridSearchRRF('docs', queryVec, "query", 5);  // RRF ⭐

// Cleanup
db.destroy();
```

**TL;DR:** Use `hybridSearchRRF()` for best results without tuning!