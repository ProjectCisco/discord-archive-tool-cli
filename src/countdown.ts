// The last chance to stop before deleting. Resolves true when the time runs out, or false on
// Ctrl+C. Catching Ctrl+C here, instead of letting it kill the process, means the run ends
// normally: its lock is released and nothing is deleted.
export function countdown(seconds: number, write: (text: string) => void, tickMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let left = seconds;
    const finish = (completed: boolean) => {
      clearInterval(timer);
      process.removeListener('SIGINT', stop);
      write('\n');
      resolve(completed);
    };
    const stop = () => finish(false);
    process.once('SIGINT', stop);
    write(`Deleting in ${left}s. Press Ctrl+C to stop. `);
    const timer = setInterval(() => {
      left -= 1;
      if (left > 0) write(`${left} `);
      else finish(true);
    }, tickMs);
  });
}
