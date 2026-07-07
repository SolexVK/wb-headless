// bot/core/queue.js — очередь задач с глобальным лимитом конкурентности и
// «дорожками» (семафорами) под лимиты источников.
//
// lane — ключ семафора (напр. 'mpstats.search', 'wb.cards-compare'): задачи на
// одной дорожке выполняются строго по одной, чтобы не превышать лимиты API.
// Глобальный concurrency ограничивает суммарное число одновременных задач.

export class Queue {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = concurrency;
    this.active = 0;
    this.pending = [];
    this.busyLanes = new Set();
  }

  /**
   * Ставит задачу в очередь. Возвращает промис результата task().
   * @param {() => Promise<any>} task
   * @param {{lane?: string}} [opts]
   */
  enqueue(task, { lane = null } = {}) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, lane, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.concurrency) {
      // берём первую задачу, чья дорожка свободна (сохраняя FIFO в пределах дорожки)
      const idx = this.pending.findIndex((j) => !j.lane || !this.busyLanes.has(j.lane));
      if (idx === -1) break;
      const job = this.pending.splice(idx, 1)[0];
      this.active++;
      if (job.lane) this.busyLanes.add(job.lane);
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          if (job.lane) this.busyLanes.delete(job.lane);
          this._drain();
        });
    }
  }

  stats() {
    return { active: this.active, pending: this.pending.length, busyLanes: [...this.busyLanes] };
  }
}
