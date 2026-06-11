import { readProxyPid, clearProxyPid, clearProxyPort, isProxyRunning } from '../proxy-config.js';

export function stopCommand(chalk) {
  if (!isProxyRunning()) {
    console.log(chalk.dim('\n  Proxy is not running.\n'));
    clearProxyPid();
    clearProxyPort();
    return;
  }
  const pid = readProxyPid();
  try {
    process.kill(pid, 'SIGTERM');
    clearProxyPid();
    clearProxyPort();
    console.log(chalk.green(`\n  Stopped proxy (PID ${pid}).\n`));
  } catch (err) {
    console.error(chalk.red(`\n  Failed to stop proxy: ${err.message}\n`));
    clearProxyPid();
    clearProxyPort();
    process.exitCode = 1;
  }
}
