import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config.lspProvisioningMode", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await createTestEnvironment();
  });

  afterEach(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("defaults to manual mode", async () => {
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.lspProvisioningMode).toBe("manual");
  });

  it("persists non-default provisioning mode and clears it when reset", async () => {
    await env.orpc.config.updateLspProvisioningMode({ mode: "auto" });

    let cfg = await env.orpc.config.getConfig();
    expect(cfg.lspProvisioningMode).toBe("auto");
    expect(env.config.loadConfigOrDefault().lspProvisioningMode).toBe("auto");

    await env.orpc.config.updateLspProvisioningMode({ mode: "manual" });

    cfg = await env.orpc.config.getConfig();
    expect(cfg.lspProvisioningMode).toBe("manual");
    expect(env.config.loadConfigOrDefault().lspProvisioningMode).toBeUndefined();
  });
});
