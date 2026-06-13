# fleet-edge-worker

**Edge compute worker** for distributed fleet processing — receives work items with priority and payload, processes them with capacity-gated acceptance, and tracks throughput via atomic counters. Built on Tokio + Serde for async, serializable fleet communication.

## Why It Matters

Edge computing moves computation closer to data sources: IoT sensors, CDN edge nodes, GPU appliances, and drone-mounted processors. The edge worker pattern is simple but universal:

1. **Receive** a work item (task type, binary payload, priority)
2. **Gate** on capacity — reject items that exceed memory/compute limits
3. **Process** — transform the payload (hash, compress, inference, etc.)
4. **Return** results with timing information

This crate implements that pattern with three production concerns:

- **Capacity bounding**: Each worker has a maximum payload size (`capacity`). Oversized work items are rejected, preventing OOM kills on resource-constrained edge devices.
- **Atomic throughput tracking**: An `AtomicU64` counter records total processed items, enabling real-time throughput monitoring without locks.
- **Serializable work model**: `WorkItem` and `WorkResult` derive `Serialize`/`Deserialize`, making them directly usable over any transport (HTTP, gRPC, WebSocket, message queue).

## How It Works

### Work Item Model

```rust
struct WorkItem {
    id: u64,
    task_type: String,    // "hash", "transform", "compress", "inference"
    data: Vec<u8>,        // Binary payload
    priority: u8,         // 0 (low) to 255 (high)
}
```

The priority field allows upstream coordinators to implement priority queues. The `task_type` enables dispatch to different processing kernels within the same worker.

### Capacity Gate

```rust
fn can_accept(&self, item: &WorkItem) -> bool {
    item.data.len() as u32 <= self.capacity
}
```

This is a hard O(1) check. In production, this would also check CPU headroom, memory pressure, and deadline feasibility.

### Processing Model

The demo implementation applies a simple transformation (`byte.wrapping_add(1)`) — a placeholder for real workloads like:

- **Hashing**: SHA-256, MurmurHash for content addressing
- **Compression**: LZ4, Zstandard for data reduction
- **ML Inference**: Forward pass through a ternary neural network
- **Transformation**: Format conversion, feature extraction

All processing is synchronous in this demo. In production, `process()` would be `async` and potentially spawn GPU tasks.

### Atomic Counter

```rust
processed: Arc<AtomicU64>
```

Using `Arc<AtomicU64>` instead of `Mutex<u64>` provides:
- **Lock-free reads**: `total_processed()` never blocks
- **Thread-safe increments**: `fetch_add(1, Ordering::Relaxed)` is ~1ns on modern CPUs
- **Shared across tasks**: The `Arc` allows multiple async tasks to update the same counter

The `Relaxed` ordering is sufficient because we don't need the counter to synchronize with other memory operations — it's a statistics counter, not a control-flow gate.

### Complexity Analysis

| Operation | Time | Space |
|-----------|------|-------|
| `new()` | O(1) | O(1) |
| `can_accept(&item)` | O(1) | O(1) |
| `process(item)` | O(n) where n = data.len() | O(n) for output |
| `total_processed()` | O(1) | O(1) |

### Throughput Calculation

If a worker processes k items of average size s in time T:

$$\text{Throughput} = \frac{k \times s}{T} \text{ bytes/second}$$

The demo processes 3 items totaling 9 bytes in 15ms (5ms each), giving 600 bytes/second — artificially low because `duration_ms` is hardcoded at 5.

## Quick Start

```rust
use fleet_edge_worker::*;

let worker = EdgeWorker::new("edge-alpha-01", 1024);

let items = vec![
    WorkItem { id: 1, task_type: "hash".into(), data: vec![10, 20, 30], priority: 5 },
    WorkItem { id: 2, task_type: "compress".into(), data: vec![40, 50], priority: 3 },
];

for item in items {
    if worker.can_accept(&item) {
        let result = worker.process(item);
        println!("Task {} done: {} output bytes", result.id, result.output.len());
    }
}

println!("Total processed: {}", worker.total_processed());
```

## API

### `EdgeWorker`
- `new(id: &str, capacity: u32) -> Self` — Create worker with max payload size
- `can_accept(&self, item: &WorkItem) -> bool` — O(1) capacity check
- `process(&self, item: WorkItem) -> WorkResult` — Transform payload, increment counter
- `total_processed(&self) -> u64` — Lock-free total count

### `WorkItem` (Serializable)
- `id: u64` — Unique task identifier
- `task_type: String` — Dispatch key ("hash", "compress", etc.)
- `data: Vec<u8>` — Binary payload
- `priority: u8` — Scheduling priority (0–255)

### `WorkResult` (Serializable)
- `id: u64` — Matches the WorkItem ID
- `output: Vec<u8>` — Transformed payload
- `duration_ms: u64` — Processing time

## Architecture Notes

The edge worker is the leaf node in the fleet topology:

```
fleet-coordinator → fleet-edge-worker (many instances)
```

The conservation link γ + η = C applies:

- **γ** (gamma) = processed work items (completed results)
- **η** (eta) = pending/rejected work items (in queue or gated)
- **C** (constant) = total work items dispatched to this worker

The capacity gate ensures γ + η = C is maintained: every item is either processed (γ) or rejected (η), with no items lost or duplicated. The atomic counter tracks γ precisely.

See the full architecture: [ARCHITECTURE.md](https://github.com/SuperInstance/SuperInstance/blob/main/ARCHITECTURE.md)

## References

1. Satyanarayanan, M., et al. (2009). "The Case for VM-Based Cloudlets in Mobile Computing." *IEEE Pervasive Computing, 8(4).* — Edge computing foundations.
2. Bonomi, F., et al. (2012). "Fog Computing and Its Role in the Internet of Things." *MCC Workshop on Mobile Cloud Computing.* — Edge/fog architecture.
3. Tokio — [tokio.rs](https://tokio.rs/) — Async runtime for Rust (used in this crate).
4. Serde — [serde.rs](https://serde.rs/) — Serialization framework for Rust.
5. Jeff D. (2018). "Lock-Free Programming with Atomics." *CppCon 2018.* — Atomic ordering semantics.

## License

MIT
