import { describe, expect, test } from "bun:test"
import { argumentPlaceholderFor, type ArgumentPlaceholderCommand } from "./argument-placeholder"

const COMMANDS: ArgumentPlaceholderCommand[] = [
  { name: "name", argumentPlaceholder: "Name…" },
  { name: "import", argumentPlaceholder: "Path…" },
  { name: "model" },
  { name: "export" },
  { name: "help" },
]

function at(line: string, cursorCol = line.length) {
  return { lines: [line], cursorLine: 0, cursorCol }
}

describe("argumentPlaceholderFor", () => {
  test("bare /name shows Name…", () => {
    expect(argumentPlaceholderFor(at("/name"), COMMANDS)).toBe("Name…")
  })

  test("/name with a trailing space still shows Name…", () => {
    expect(argumentPlaceholderFor(at("/name "), COMMANDS)).toBe("Name…")
  })

  test("/name with several trailing spaces still shows Name…", () => {
    expect(argumentPlaceholderFor(at("/name   "), COMMANDS)).toBe("Name…")
  })

  test("/import shows Path…", () => {
    expect(argumentPlaceholderFor(at("/import"), COMMANDS)).toBe("Path…")
  })

  test("a real argument hides the ghost", () => {
    expect(argumentPlaceholderFor(at("/name X"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/name My project"), COMMANDS)).toBeUndefined()
  })

  test("cursor before the end hides the ghost", () => {
    expect(argumentPlaceholderFor(at("/name ", 0), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/name", 3), COMMANDS)).toBeUndefined()
  })

  test("multiline input hides the ghost", () => {
    expect(argumentPlaceholderFor({ lines: ["/name", ""], cursorLine: 1, cursorCol: 0 }, COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor({ lines: ["/name", "x"], cursorLine: 0, cursorCol: 5 }, COMMANDS)).toBeUndefined()
  })

  test("partial and malformed commands hide the ghost", () => {
    expect(argumentPlaceholderFor(at("/nam"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/namefoo"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/name/foo"), COMMANDS)).toBeUndefined()
  })

  test("unknown commands hide the ghost", () => {
    expect(argumentPlaceholderFor(at("/foo"), COMMANDS)).toBeUndefined()
  })

  test("commands without a placeholder hide the ghost", () => {
    expect(argumentPlaceholderFor(at("/model"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/export"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/help"), COMMANDS)).toBeUndefined()
  })

  test("a bare slash with only whitespace hides the ghost", () => {
    expect(argumentPlaceholderFor(at("/   "), COMMANDS)).toBeUndefined()
  })
})
