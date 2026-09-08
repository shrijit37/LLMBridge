/**
 * High-performance circular buffer storing the last N items.
 * Avoids array shift/splice allocations on high-throughput proxy traffic.
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private capacity: number;
  private head = 0;
  private currentSize = 0;

  constructor(capacity = 100) {
    this.capacity = Math.max(1, capacity);
    this.buffer = new Array(this.capacity);
  }

  public push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.currentSize < this.capacity) {
      this.currentSize++;
    }
  }

  public getRecent(limit?: number): T[] {
    const maxCount = limit !== undefined ? Math.min(limit, this.currentSize) : this.currentSize;
    const result: T[] = [];

    // Traverse backwards from latest item to oldest
    for (let i = 0; i < maxCount; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) {
        result.push(item);
      }
    }

    return result;
  }

  public resize(newCapacity: number): void {
    if (newCapacity === this.capacity) return;
    const currentItems = this.getRecent();
    this.capacity = Math.max(1, newCapacity);
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.currentSize = 0;

    // Repopulate in oldest to newest order
    for (let i = currentItems.length - 1; i >= 0; i--) {
      this.push(currentItems[i]!);
    }
  }

  public size(): number {
    return this.currentSize;
  }

  public clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.currentSize = 0;
  }
}
