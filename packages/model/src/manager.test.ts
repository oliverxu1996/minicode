import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { ModelError } from "./errors"
import { ModelManager } from "./manager"
import {
  configFile,
  readConfigFile,
  testConfig,
  withConfigDir,
  writeConfigFile,
} from "./test-support"

describe("ModelManager loading", () => {
  test("missing config file loads an empty manager", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      expect(manager.list()).toEqual([])
      expect(manager.active()).toBeUndefined()
      expect(manager.get("anything")).toBeUndefined()
    })
  })

  test("valid config file loads models and active model", async () => {
    await withConfigDir(async () => {
      writeConfigFile(JSON.stringify({
        version: 1,
        models: [
          testConfig({ id: "a", name: "A" }),
          testConfig({ id: "b", name: "B" }),
        ],
        activeModelId: "b",
      }))

      const manager = await ModelManager.load()
      expect(manager.list().map(model => model.id)).toEqual(["a", "b"])
      expect(manager.active()?.id).toBe("b")
      expect(manager.get("a")?.name).toBe("A")
    })
  })

  test("malformed JSON fails and the file is left untouched", async () => {
    await withConfigDir(async () => {
      const broken = "{ this is not json"
      writeConfigFile(broken)

      try {
        await ModelManager.load()
        throw new Error("expected load to throw")
      } catch (error) {
        expect(error).toBeInstanceOf(ModelError)
        expect((error as ModelError).code).toBe("configuration_error")
      }

      expect(readConfigFile()).toBe(broken)
    })
  })

  test("wrong envelope version fails", async () => {
    await withConfigDir(async () => {
      writeConfigFile(JSON.stringify({ version: 2, models: [], activeModelId: null }))
      expect(ModelManager.load()).rejects.toBeInstanceOf(ModelError)
    })
  })

  test("invalid persisted model entry fails", async () => {
    await withConfigDir(async () => {
      writeConfigFile(JSON.stringify({
        version: 1,
        models: [testConfig({ id: "a", contextWindow: -1 })],
        activeModelId: null,
      }))
      expect(ModelManager.load()).rejects.toBeInstanceOf(ModelError)
    })
  })

  test("activeModelId referencing an unknown model fails", async () => {
    await withConfigDir(async () => {
      writeConfigFile(JSON.stringify({
        version: 1,
        models: [testConfig({ id: "a" })],
        activeModelId: "ghost",
      }))
      expect(ModelManager.load()).rejects.toBeInstanceOf(ModelError)
    })
  })

  test("duplicate ids in the file fail", async () => {
    await withConfigDir(async () => {
      writeConfigFile(JSON.stringify({
        version: 1,
        models: [testConfig({ id: "a" }), testConfig({ id: "a" })],
        activeModelId: null,
      }))
      expect(ModelManager.load()).rejects.toBeInstanceOf(ModelError)
    })
  })

  test("reload preserves state across manager instances", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "a", name: "A" }))
      manager.add(testConfig({ id: "b", name: "B" }))
      manager.activate("b")

      const reloaded = await ModelManager.load()
      expect(reloaded.list().map(model => model.id)).toEqual(["a", "b"])
      expect(reloaded.active()?.id).toBe("b")
      expect(reloaded.get("a")?.limits).toEqual({
        contextWindow: 128000,
        maxOutputTokens: 32000,
      })
    })
  })
})

describe("ModelManager add", () => {
  test("add returns a callable model with identity and limits", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      const model = manager.add(testConfig())

      expect(model.id).toBe("test-model")
      expect(model.name).toBe("Test Model")
      expect(model.limits).toEqual({ contextWindow: 128000, maxOutputTokens: 32000 })
    })
  })

  test("the first model becomes active automatically", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "first" }))
      manager.add(testConfig({ id: "second" }))

      expect(manager.active()?.id).toBe("first")
    })
  })

  test("duplicate id is rejected", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "dup" }))

      expect(() => manager.add(testConfig({ id: "dup", name: "Other" }))).toThrow(ModelError)
      expect(manager.list()).toHaveLength(1)
    })
  })

  test("ids are trimmed on write and lookups", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "  spaced  " }))

      expect(manager.get("spaced")).toBeDefined()
      expect(() => manager.add(testConfig({ id: "spaced" }))).toThrow(ModelError)
    })
  })

  test("invalid configuration is rejected and not persisted", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      expect(() => manager.add(testConfig({ contextWindow: 0 }))).toThrow(ModelError)

      // Nothing was persisted: the file does not exist.
      const reloaded = await ModelManager.load()
      expect(reloaded.list()).toEqual([])
    })
  })
})

describe("ModelManager update", () => {
  test("update replaces the full configuration", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig())

      manager.update(testConfig({
        name: "Renamed",
        model: "other-model",
        endpoint: "https://example.com/v1",
        contextWindow: 200000,
        maxOutputTokens: 64000,
      }))

      const model = manager.get("test-model")!
      expect(model.name).toBe("Renamed")
      expect(model.limits).toEqual({ contextWindow: 200000, maxOutputTokens: 64000 })

      const reloaded = await ModelManager.load()
      expect(reloaded.get("test-model")?.name).toBe("Renamed")
      expect(reloaded.get("test-model")?.limits).toEqual({
        contextWindow: 200000,
        maxOutputTokens: 64000,
      })
    })
  })

  test("updating the active model keeps it active", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig())
      manager.update(testConfig({ name: "Still active" }))

      expect(manager.active()?.name).toBe("Still active")
    })
  })

  test("update of an unknown model fails", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      expect(() => manager.update(testConfig())).toThrow(ModelError)
    })
  })

  test("updated configuration is persisted", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig())
      manager.update(testConfig({ model: "changed-model" }))

      const persisted = JSON.parse(readConfigFile())
      expect(persisted.models[0].model).toBe("changed-model")
    })
  })
})

describe("ModelManager remove", () => {
  test("remove deletes the model and persists", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "a" }))
      manager.remove("a")

      expect(manager.get("a")).toBeUndefined()
      expect(manager.list()).toEqual([])

      const reloaded = await ModelManager.load()
      expect(reloaded.list()).toEqual([])
    })
  })

  test("removing the active model leaves no active model", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "a" }))
      manager.add(testConfig({ id: "b" }))
      manager.activate("a")
      manager.remove("a")

      expect(manager.active()).toBeUndefined()
      // The remaining model is NOT auto-activated.
      expect(manager.get("b")).toBeDefined()

      const reloaded = await ModelManager.load()
      expect(reloaded.active()).toBeUndefined()
      expect(reloaded.get("b")).toBeDefined()
    })
  })

  test("remove of an unknown model fails", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      expect(() => manager.remove("ghost")).toThrow(ModelError)
    })
  })
})

describe("ModelManager activate", () => {
  test("activate selects an existing model", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "a" }))
      manager.add(testConfig({ id: "b" }))
      manager.activate("b")

      expect(manager.active()?.id).toBe("b")

      const reloaded = await ModelManager.load()
      expect(reloaded.active()?.id).toBe("b")
    })
  })

  test("activate of an unknown model fails", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      expect(() => manager.activate("ghost")).toThrow(ModelError)
    })
  })
})

describe("ModelManager persistence", () => {
  test("mutations persist atomically: valid file, no leftover temporaries", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "a" }))
      manager.add(testConfig({ id: "b" }))
      manager.remove("a")
      manager.activate("b")

      const persisted = JSON.parse(readConfigFile())
      expect(persisted).toEqual({
        version: 1,
        models: [expect.objectContaining({ id: "b" })],
        activeModelId: "b",
      })
    })
  })

  test("no temporary files are left behind by atomic writes", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig())
      manager.update(testConfig({ name: "Renamed" }))

      const { readdirSync } = await import("node:fs")
      const dir = process.env.MINICODE_CONFIG_DIR!
      expect(readdirSync(dir)).toEqual(["models.json"])
    })
  })

  test("a failed persist leaves the manager unchanged", async () => {
    await withConfigDir(async () => {
      const { chmodSync } = await import("node:fs")
      const dir = process.env.MINICODE_CONFIG_DIR!
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "a" }))

      // Make the directory read-only so the next persist fails.
      chmodSync(dir, 0o500)
      try {
        expect(() => manager.add(testConfig({ id: "b" }))).toThrow(ModelError)
        expect(manager.list().map(model => model.id)).toEqual(["a"])
      } finally {
        chmodSync(dir, 0o700)
      }
    })
  })

  test("the persisted envelope matches the documented shape", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig())

      const persisted = JSON.parse(readConfigFile())
      expect(Object.keys(persisted).sort()).toEqual(["activeModelId", "models", "version"])
      expect(persisted.version).toBe(1)
      expect(persisted.models[0]).toEqual({
        id: "test-model",
        name: "Test Model",
        protocol: "openai",
        endpoint: "http://127.0.0.1:9",
        model: "test-model",
        apiKey: "sk-test-secret-123",
        contextWindow: 128000,
        maxOutputTokens: 32000,
      })
    })
  })
})

describe("ModelManager list and get", () => {
  test("list returns all models in configuration order", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "c" }))
      manager.add(testConfig({ id: "a" }))

      expect(manager.list().map(model => model.id)).toEqual(["c", "a"])
    })
  })

  test("get returns undefined for unknown ids", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      manager.add(testConfig({ id: "a" }))

      expect(manager.get("nope")).toBeUndefined()
    })
  })

  test("active() is undefined when nothing is active", async () => {
    await withConfigDir(async () => {
      const manager = await ModelManager.load()
      expect(manager.active()).toBeUndefined()
    })
  })
})
