export class Logger {
  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string): void {
    this.write('ERROR', message);
  }

  trade(message: string): void {
    this.write('TRADE', message);
  }

  status(message: string): void {
    const ts = new Date().toLocaleTimeString();
    console.log(`-- ${ts} -- ${message}`);
  }

  private write(level: string, message: string): void {
    const ts = new Date().toLocaleTimeString();
    console.log(`${ts} [${level}] ${message}`);
  }
}
