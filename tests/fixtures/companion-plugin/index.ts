export function createHostFunctions() {
  return {
    "companion-mod": {
      hello: () => ({ message: "companion says hello" }),
    },
  };
}
