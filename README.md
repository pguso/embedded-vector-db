# embedded-vector-db - Embedded Vector Database for Node.js

> **Beta Notice**: `embedded-vector-db` is currently in active development and considered beta software. APIs may change until version 1.0. Use with caution in production environments.

## Overview
`embedded-vector-db` is a lightweight **npm package** providing an embedded vector database solution for Node.js applications. This self-contained package offers efficient vector similarity search combined with metadata storage and full-text search capabilities. Built on top of `hnswlib-node` for k-nearest neighbor (kNN) search, it provides:

- Multi-namespace support for data isolation
- CRUD operations for vector entries
- Metadata filtering on search operations
- Full-text search across specified metadata fields
- Concurrent read/write operations with proper locking
- Automatic compaction and index maintenance
- Persistent storage capabilities

**Package Features**:
- **Embedded npm package** - Runs directly in your Node.js process
- **Self-contained** - Only requires standard npm dependencies
- **Typed interfaces** - Full TypeScript support included
- **Concurrency safe** - Mutex and semaphore protected operations
- **Beta state** - Actively developed with stable release coming soon

## Installation

1. Install the package:
```bash
npm install embedded-vector-db
```

2. Ensure python3 is installed

## Basic Usage

### Initialization
```typescript
import { VectorDB } from 'embedded-vector-db';

// Initialize with vector dimension and maximum elements
const db = new VectorDB({
    dim: 128,       // Dimension of your vectors
    maxElements: 10000 // Maximum number of elements to store
});
```

### Core Operations
```typescript
// Insert a vector
await db.insert('my-namespace', 'item1', Array(128).fill(0.5), { 
    category: 'books', 
    description: 'A sample book' 
});

// Similarity search
const results = await db.search('my-namespace', Array(128).fill(0.4), 3);

// Update vector data
await db.update('my-namespace', 'item1', Array(128).fill(0.6), {
    category: 'updated-books'
});

// Delete entry
await db.delete('my-namespace', 'item1');
```

## Beta Considerations
While functional, please note during beta:
- API surface may change in minor versions
- Performance characteristics still being optimized
- Additional test coverage being added
- Documentation undergoing improvements
- Community feedback actively solicited

Report issues at: [https://github.com/pguso/embedded-vector-db](https://github.com/pguso/embedded-vector-db)

## Configuration
The package requires initialization with:
```typescript
interface VectorDBConfig {
    dim: number;      // Vector dimensions
    maxElements: number; // Maximum storage capacity
}
```

**Important**: `maxElements` is permanent after initialization

## Namespace Management
```typescript
// Configure full-text search fields
await db.setFullTextIndexedFields('books', ['title']);

// Save namespace state
await db.save('books', './data/books-ns');

// Load persisted data
await db.load('books', './data/books-ns');
```

## Persistence Model
```typescript
// Save operation creates:
// - books-ns.idx (HNSW index)
// - books-ns.meta.json (Metadata mappings)

// Load before operations after restart
await db.load('books', './data/books-ns');
```

## Contributing
As a beta package, contributions are welcome:
```bash
git clone https://github.com/yourorg/embedded-vector-db.git
npm install
npm run build
```

See CONTRIBUTING.md for development guidelines.

## Roadmap to 1.0
- [ ] Performance benchmarking suite
- [ ] Browser build support
- [ ] Enhanced documentation
- [ ] Stress testing utilities
- [ ] ARM architecture support
- [ ] Migration tools for schema changes

## License
MIT Licensed - See included `LICENSE` file. Beta software provided without warranty.