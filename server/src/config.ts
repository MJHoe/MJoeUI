import { promises as fs, constants as fsc } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';

export class Config {
  private filePath: string;
  baseUrl: string = DEFAULT_BASE_URL;
  /** Where finished images/videos are written. Absolute path. */
  outputDir: string;

  constructor(dataDir: string, readonly defaultOutputDir: string) {
    this.filePath = path.join(dataDir, 'config.json');
    this.outputDir = defaultOutputDir;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const obj = JSON.parse(raw);
      if (typeof obj.baseUrl === 'string') this.baseUrl = obj.baseUrl;
      if (typeof obj.outputDir === 'string' && path.isAbsolute(obj.outputDir)) this.outputDir = obj.outputDir;
    } catch {
      await this.save();
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify(
        {
          baseUrl: this.baseUrl,
          ...(this.outputDir !== this.defaultOutputDir && { outputDir: this.outputDir }),
        },
        null,
        2,
      ),
    );
  }

  async setBaseUrl(url: string) {
    const clean = url.trim().replace(/\/+$/, '');
    // throws on garbage, which the route turns into a 400
    const u = new URL(clean);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('地址需要以 http:// 或 https:// 开头');
    }
    this.baseUrl = clean;
    await this.save();
  }

  /**
   * Accepts `~/…` or an absolute path, creates it if needed and makes sure we
   * can write there before switching, so a typo never silently drops images.
   */
  async setOutputDir(input: string) {
    let p = input.trim();
    if (!p) p = this.defaultOutputDir;
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) throw new Error('请填写完整路径，比如 ~/Pictures/MJoeUI');
    p = path.resolve(p);
    try {
      await fs.mkdir(p, { recursive: true });
      await fs.access(p, fsc.W_OK);
    } catch (e: any) {
      if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error('没有权限写入这个目录');
      if (e.code === 'ENOTDIR' || e.code === 'EEXIST') throw new Error('这个路径上已经有一个同名文件');
      if (e.code === 'ENOENT' || e.code === 'EROFS') throw new Error('无法在这里创建文件夹，检查路径是否在可写的磁盘上');
      throw new Error(`无法使用这个目录：${e.message}`);
    }
    this.outputDir = p;
    await this.save();
  }

  get wsOrigin(): string {
    const u = new URL(this.baseUrl);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}`;
  }

  async probe(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(3000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }
}
