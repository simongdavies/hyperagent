// Test plugin — returns a simple greet function
// Uses path.join for path construction (should flag as info)
import { join as _join } from "node:path";

interface TestPluginConfig {
  greeting: string;
  maxItems: number;
}

interface TestModFunctions {
  greet: (name: string) => string;
  count: () => number;
}

export function createHostFunctions(config: TestPluginConfig): {
  testmod: TestModFunctions;
} {
  return {
    testmod: {
      greet: (name: string) => {
        return `${config.greeting}, ${name}!`;
      },
      count: () => {
        return config.maxItems;
      },
    },
  };
}
