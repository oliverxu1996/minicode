import { describe, expect, test } from "bun:test"
import { TuiHarness } from "./testing"

function clean(line: string): string {
	return line.replace(/[│┃]\s*$/, "").trimEnd()
}

function make(chatLines = 60): TuiHarness {
	return new TuiHarness({ width: 60, height: 24, chatLines }).start()
}

describe("Conversation scrolling", () => {
	test("PageUp moves the viewport up and suspends follow", () => {
		const h = make()
		expect(h.following).toBe(true)
		const before = h.screen().map(clean)
		h.feed("\x1b[5~")
		const after = h.screen().map(clean)
		expect(h.scrollTop).toBeLessThan(43)
		expect(h.following).toBe(false)
		expect(after[0]).not.toBe(before[0])
	})

	test("PageDown moves the viewport down", () => {
		const h = make()
		h.feed("\x1b[5~")
		const up = h.scrollTop
		h.feed("\x1b[6~")
		expect(h.scrollTop).toBeGreaterThan(up)
	})

	test("PageDown at the bottom is a no-op and stays following", () => {
		const h = make()
		const bottom = h.scrollTop
		expect(h.following).toBe(true)
		h.feed("\x1b[6~")
		expect(h.scrollTop).toBe(bottom)
		expect(h.following).toBe(true)
	})

	test("PageUp at the top is a no-op", () => {
		const h = make()
		h.feed("\x1b[1~") // Home
		expect(h.scrollTop).toBe(0)
		h.feed("\x1b[5~")
		expect(h.scrollTop).toBe(0)
	})

	test("Home shows the conversation top and disables follow", () => {
		const h = make()
		h.feed("\x1b[1~")
		const rows = h.screen().map(clean)
		expect(h.scrollTop).toBe(0)
		expect(h.following).toBe(false)
		expect(rows[0]).toBe("header-0")
	})

	test("End shows the conversation bottom and resumes follow", () => {
		const h = make()
		h.feed("\x1b[1~")
		expect(h.following).toBe(false)
		h.feed("\x1b[4~")
		const rows = h.screen().map(clean)
		expect(h.following).toBe(true)
		expect(rows.findLast(line => line.startsWith("chat-"))).toBe("chat-59")
	})

	test("wheel-up scrolls up and disables follow; wheel-down returns toward the bottom", () => {
		const h = make()
		expect(h.following).toBe(true)
		h.feed("\x1b[<64;10;10M") // wheel up
		expect(h.following).toBe(false)
		expect(h.scrollTop).toBeLessThan(43)
		const scrolled = h.scrollTop
		h.feed("\x1b[<65;10;10M") // wheel down
		expect(h.scrollTop).toBe(scrolled + 1)
		// Scrolling all the way back down resumes follow.
		for (let i = 0; i < 100; i++) h.feed("\x1b[<65;10;10M")
		expect(h.following).toBe(true)
	})
})

describe("Auto-follow", () => {
	test("streamed content follows while pinned to the bottom", () => {
		const h = make()
		expect(h.following).toBe(true)
		h.chat.count += 5
		const rows = h.screen().map(clean)
		expect(h.following).toBe(true)
		expect(rows.findLast(line => line.startsWith("chat-"))).toBe("chat-64")
	})

	test("manual scroll up suspends follow", () => {
		const h = make()
		h.feed("\x1b[5~")
		expect(h.following).toBe(false)
	})

	test("streamed content does not yank a scrolled-up viewport", () => {
		const h = make()
		h.feed("\x1b[5~")
		const held = h.scrollTop
		const topRow = h.screen().map(clean)[0]
		h.chat.count += 10
		const rows = h.screen().map(clean)
		expect(h.scrollTop).toBe(held)
		expect(h.following).toBe(false)
		expect(rows[0]).toBe(topRow)
	})

	test("reaching the bottom resumes follow for subsequent streaming", () => {
		const h = make()
		h.feed("\x1b[5~")
		h.chat.count += 10
		h.feed("\x1b[4~") // End
		expect(h.following).toBe(true)
		h.chat.count += 3
		const rows = h.screen().map(clean)
		expect(h.following).toBe(true)
		expect(rows.findLast(line => line.startsWith("chat-"))).toBe(`chat-${72}`)
	})

	test("returning to the bottom by wheel resumes follow", () => {
		const h = make()
		h.feed("\x1b[5~")
		expect(h.following).toBe(false)
		for (let i = 0; i < 200; i++) h.feed("\x1b[<65;10;10M")
		expect(h.following).toBe(true)
		h.chat.count += 2
		expect(h.screen().map(clean).findLast(line => line.startsWith("chat-"))).toBe("chat-61")
	})
})
