// Logs the start and end of every MCP tool call, so a call that never finishes shows up as a start with no end.
type Registrar = { registerTool: (...args: any[]) => any };

export function tracedServer<S extends Registrar>(server: S, tag: string): S {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name: string, ...rest: any[]) => {
          const last = rest.length - 1;
          const cb = rest[last];
          if (typeof cb === "function") {
            rest[last] = async (...args: any[]) => {
              const t0 = Date.now();
              console.log(`tool-start ${tag} ${name}`);
              try {
                const out = await cb(...args);
                console.log(`tool-end ${tag} ${name} ${Date.now() - t0}ms`);
                return out;
              } catch (e) {
                console.log(`tool-fail ${tag} ${name} ${Date.now() - t0}ms`);
                throw e;
              }
            };
          }
          return target.registerTool(name, ...rest);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
