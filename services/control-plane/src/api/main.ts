import { startProductionApi } from "./productionApiFactories.js";

if (process.argv[1] === import.meta.filename) {
  void startProductionApi().catch(() => {
    process.stderr.write("CrewRoll API startup failed.\n");
    process.exitCode = 1;
  });
}
