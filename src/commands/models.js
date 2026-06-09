import { detectLocalServers } from '../detect.js';

export async function modelsCommand(chalk) {
  process.stdout.write(chalk.dim('\n  Detecting local inference servers...\n'));
  let servers;
  try {
    servers = await detectLocalServers();
  } catch (err) {
    console.error(chalk.red(`  Error: ${err.message}`));
    process.exitCode = 1;
    return;
  }

  if (servers.length === 0) {
    console.log(chalk.yellow('  No local inference servers found.\n'));
    console.log(chalk.dim('  Start Ollama with: ollama serve'));
    console.log(chalk.dim('  Start LM Studio and enable the local server.\n'));
    return;
  }

  console.log();
  for (const srv of servers) {
    const label = srv.name.charAt(0).toUpperCase() + srv.name.slice(1);
    console.log(`  ${chalk.bold(label)}  ${chalk.dim(srv.url)}`);
    if (srv.models.length === 0) {
      console.log(chalk.dim('    (no models loaded)'));
    } else {
      for (const m of srv.models) console.log(`    ${chalk.cyan(m)}`);
    }
    console.log();
  }
}
