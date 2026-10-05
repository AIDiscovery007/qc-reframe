import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';

// Prepare a separate manager before closing this process. No client-supplied command or path.
export async function prepareRestart({ root, dataDir, port, instanceId, restartId, skillPath, generationSkillPath }) {
  const log = await open(join(dataDir, 'logs', 'bridge.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [join(root, 'scripts/manage.mjs'), 'restart-after', instanceId], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd, 'ipc'],
      env: { ...process.env, ALCHEMY_DATA_DIR: dataDir, ALCHEMY_PORT: String(port), ALCHEMY_RESTART_ID: restartId,
        ALCHEMY_SKILL_PATH: skillPath, IMAGEGEN_SKILL_PATH: generationSkillPath },
    });
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(5000) }),
      once(child, 'exit').then(() => { throw new Error('重启管理进程未能启动'); }),
    ]);
    if (message !== 'ready') throw new Error('重启管理进程未就绪');
    return () => { child.send('restart', error => { if (error) console.error('重启交接失败：', error.message); }); child.unref(); child.channel?.unref(); };
  } catch (error) { child?.kill(); throw error; }
  finally { await log.close(); }
}
