import { runApi } from "./apiRuntime.js";
import { productionApiFactories } from "./productionApiFactories.js";

if (process.argv[1] === import.meta.filename) {
  void runApi(productionApiFactories).catch(() => {
    process.stderr.write("CrewRoll API startup failed.\n");
    process.exitCode = 1;
  });
}
