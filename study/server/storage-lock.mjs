import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** A second HTTP listener must never hold an independent writable snapshot of this directory. */
export function acquireStorageLock(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'writer.lock');
  const recoveryFile = path.join(directory, 'writer-recovery.lock');
  const token = randomUUID();
  const alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; return true; }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      fs.closeSync(descriptor);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); }
        catch (error) { if (error.code !== 'ENOENT') console.error('数据目录锁未释放，请检查 writer.lock。'); }
      };
    } catch (error) {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
      if (error.code !== 'EEXIST') throw error;
    }
    // Serialize stale-owner recovery so a second starter cannot remove a newly acquired lock.
    let recovery;
    try {
      recovery = fs.openSync(recoveryFile, 'wx', 0o600);
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw new Error('数据目录锁损坏，已阻止启动以保护学习记录；请保留 writer.lock 后检查。');
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') throw new Error('数据目录锁无效，已阻止第二个写入服务。');
      if (alive(owner.pid)) throw new Error(`学习数据正由进程 ${owner.pid} 使用，已阻止第二个服务写入同一目录。`);
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('数据目录正在恢复锁，请稍后重新启动。');
      throw error;
    } finally {
      if (recovery !== undefined) { fs.closeSync(recovery); fs.unlinkSync(recoveryFile); }
    }
  }
  throw new Error('未能取得学习数据独占锁，服务未启动。');
}
