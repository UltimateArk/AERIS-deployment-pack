// Fixed-size circular buffer of Float64 rows (one row per 10 Hz tick).
class RingBuffer {
  constructor(capacity, cols) {
    this.cap = capacity;
    this.cols = cols;
    this.data = new Float64Array(capacity * cols);
    this.ts = new Float64Array(capacity);
    this.head = 0; // next write slot
    this.size = 0;
  }
  push(ts, row) {
    this.data.set(row, this.head * this.cols);
    this.ts[this.head] = ts;
    this.head = (this.head + 1) % this.cap;
    if (this.size < this.cap) this.size++;
  }
  _slot(back) {
    return (this.head - 1 - back + this.cap * 2) % this.cap;
  } // back=0 -> newest
  get(col, back = 0) {
    if (back >= this.size) back = this.size - 1;
    return this.data[this._slot(back) * this.cols + col];
  }
  mean(col, n) {
    n = Math.min(n, this.size);
    let s = 0;
    for (let i = 0; i < n; i++) s += this.data[this._slot(i) * this.cols + col];
    return s / n;
  }
  clear() {
    this.head = 0;
    this.size = 0;
  }
}
module.exports = RingBuffer;
