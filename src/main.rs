use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Debug, Serialize, Deserialize)]
struct WorkItem {
    id: u64,
    task_type: String,
    data: Vec<u8>,
    priority: u8,
}

#[derive(Debug, Serialize, Deserialize)]
struct WorkResult {
    id: u64,
    output: Vec<u8>,
    duration_ms: u64,
}

struct EdgeWorker {
    worker_id: String,
    processed: Arc<AtomicU64>,
    capacity: u32,
}

impl EdgeWorker {
    fn new(id: &str, capacity: u32) -> Self {
        Self {
            worker_id: id.to_string(),
            processed: Arc::new(AtomicU64::new(0)),
            capacity,
        }
    }

    fn can_accept(&self, item: &WorkItem) -> bool {
        item.data.len() as u32 <= self.capacity
    }

    fn process(&self, item: WorkItem) -> WorkResult {
        let output = item.data.iter().map(|b| b.wrapping_add(1)).collect();
        self.processed.fetch_add(1, Ordering::Relaxed);
        WorkResult {
            id: item.id,
            output,
            duration_ms: 5,
        }
    }

    fn total_processed(&self) -> u64 {
        self.processed.load(Ordering::Relaxed)
    }
}

fn main() -> Result<()> {
    let worker = EdgeWorker::new("edge-alpha-01", 1024);

    let items = vec![
        WorkItem { id: 1, task_type: "hash".into(), data: vec![10, 20, 30], priority: 5 },
        WorkItem { id: 2, task_type: "transform".into(), data: vec![40, 50], priority: 3 },
        WorkItem { id: 3, task_type: "compress".into(), data: vec![60, 70, 80, 90], priority: 8 },
    ];

    for item in items {
        if worker.can_accept(&item) {
            let result = worker.process(item);
            println!("[{}] Task {} done in {}ms, {} output bytes",
                     worker.worker_id, result.id, result.duration_ms, result.output.len());
        } else {
            println!("[{}] Task {} rejected — exceeds capacity", worker.worker_id, item.id);
        }
    }

    println!("Total processed: {}", worker.total_processed());
    Ok(())
}
