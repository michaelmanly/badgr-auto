import { detectLocalServers } from '../detect.js';
import { saveProxyConfig, isProxyRunning } from '../proxy-config.js';

export async function selectCommand(modelName, chalk) {
  if (!modelName) {
    console.error(chalk.red('\n  Usage: badgr-auto select <model>\n'));
    process.exitCode = 1;
    return;
  }

  process.stdout.write(chalk.dim('  Looking up model in local servers...\n'));
  let servers;
  try {
    servers = await detectLocalServers();
  } catch (err) {
    console.error(chalk.red(`  Error: ${err.message}`));
    process.exitCode = 1;
    return;
  }

  const found = servers.find(srv => srv.models.includes(modelName));
  if (!found) {
    console.error(chalk.red(`\n  Model '${modelName}' not found in any running local server.\n`));
    console.log(chalk.dim('  Run badgr-auto models to see available models.\n'));
    process.exitCode = 1;
    return;
  }

  saveProxyConfig({ selectedModel: modelName, serverName: found.name, serverUrl: found.url });
  console.log(chalk.green(`\n  Selected: ${modelName}  ${chalk.dim(`(${found.name})`)}\n`));
  if (!isProxyRunning()) {
    console.log(chalk.dim('  Proxy is not running. Start it with: badgr-auto start\n'));
  }
}
