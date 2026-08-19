import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  appendHistory,
  buildSaveFilePath,
  cleanupCache,
  clearHistory,
  formatHistoryTime,
  generateQrcodePng,
  getQrcodeCacheDir,
  hashText,
  loadHistory,
  parseErrorCorrectionLevel,
  parseHistoryLimit,
  parseSize,
  removeHistory,
  resolveDownloadDirectory,
  writeQrcodePngFile
} from "../qrcode"

describe("parseSize", () => {
  test("解析合法尺寸", () => {
    expect(parseSize("256")).toBe(256)
    expect(parseSize("1024")).toBe(1024)
  })

  test("非法输入回退默认 512", () => {
    expect(parseSize(undefined)).toBe(512)
    expect(parseSize("")).toBe(512)
    expect(parseSize("abc")).toBe(512)
  })

  test("过小或过大尺寸被截断", () => {
    expect(parseSize("10")).toBe(512)
    expect(parseSize("99999")).toBe(4096)
  })
})

describe("parseErrorCorrectionLevel", () => {
  test("解析合法等级（不区分大小写）", () => {
    expect(parseErrorCorrectionLevel("L")).toBe("L")
    expect(parseErrorCorrectionLevel("q")).toBe("Q")
    expect(parseErrorCorrectionLevel("H")).toBe("H")
  })

  test("非法输入回退默认 M", () => {
    expect(parseErrorCorrectionLevel(undefined)).toBe("M")
    expect(parseErrorCorrectionLevel("X")).toBe("M")
    expect(parseErrorCorrectionLevel("")).toBe("M")
  })
})

describe("hashText", () => {
  test("相同文本生成相同摘要", () => {
    expect(hashText("hello")).toBe(hashText("hello"))
  })

  test("不同文本生成不同摘要", () => {
    expect(hashText("hello")).not.toBe(hashText("world"))
  })

  test("摘要长度为 16 且为十六进制", () => {
    expect(hashText("https://example.com")).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("getQrcodeCacheDir", () => {
  test("缓存目录独立于插件目录且包含专属子目录名", () => {
    const dir = getQrcodeCacheDir()
    expect(dir).toContain("qrcode-cache")
    // Windows 下应位于 APPDATA\Wox\Data 下
    if (process.platform === "win32" && process.env.APPDATA) {
      expect(dir.startsWith(path.join(process.env.APPDATA, "Wox"))).toBe(true)
    }
  })
})

describe("resolveDownloadDirectory", () => {
  test("优先使用显式设置", () => {
    expect(resolveDownloadDirectory("D:\\qrcodes")).toBe("D:\\qrcodes")
    expect(resolveDownloadDirectory("  /tmp/qr  ")).toBe("/tmp/qr")
  })

  test("空设置回退到系统下载目录", () => {
    const home = process.env.USERPROFILE || process.env.HOME || ""
    const expected = home ? path.join(home, "Downloads") : "."
    expect(resolveDownloadDirectory("")).toBe(expected)
    expect(resolveDownloadDirectory(undefined)).toBe(expected)
  })
})

describe("generateQrcodePng", () => {
  test("生成有效 PNG buffer", async () => {
    const buffer = await generateQrcodePng("https://github.com", { width: 256, errorCorrectionLevel: "M" })
    // PNG 魔数 + 正常数据量
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(buffer.length).toBeGreaterThan(1000)
  })
})

describe("writeQrcodePngFile", () => {
  const cacheDir = path.join(os.tmpdir(), `wox-qrcode-test-${Date.now()}`)

  afterAll(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  test("写入文件并复用相同内容的文件", async () => {
    const options = { width: 256, errorCorrectionLevel: "M" as const }
    const first = await writeQrcodePngFile(cacheDir, "same content", options)
    const second = await writeQrcodePngFile(cacheDir, "same content", options)
    expect(first).toBe(second)
    expect(fs.existsSync(first)).toBe(true)

    const different = await writeQrcodePngFile(cacheDir, "other content", options)
    expect(different).not.toBe(first)
  })
})

describe("cleanupCache", () => {
  const cacheDir = path.join(os.tmpdir(), `wox-qrcode-cleanup-${Date.now()}`)

  afterAll(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  test("超过上限的旧文件被清理", async () => {
    fs.mkdirSync(cacheDir, { recursive: true })
    const options = { width: 64, errorCorrectionLevel: "L" as const }
    for (let index = 0; index < 5; index += 1) {
      await writeQrcodePngFile(cacheDir, `file-${index}`, options)
    }

    cleanupCache(cacheDir, 3)
    const remaining = fs
      .readdirSync(cacheDir)
      .filter(name => name.endsWith(".png"))
      .filter(name => !name.endsWith(".tmp"))
    expect(remaining.length).toBe(3)
  })
})

describe("parseHistoryLimit", () => {
  test("解析合法条数", () => {
    expect(parseHistoryLimit("80")).toBe(80)
    expect(parseHistoryLimit("200")).toBe(200)
  })

  test("非法输入回退默认 50", () => {
    expect(parseHistoryLimit(undefined)).toBe(50)
    expect(parseHistoryLimit("")).toBe(50)
    expect(parseHistoryLimit("abc")).toBe(50)
  })

  test("过小或过大条数被截断", () => {
    expect(parseHistoryLimit("5")).toBe(50)
    expect(parseHistoryLimit("9999")).toBe(200)
  })
})

describe("history 读写", () => {
  const historyFile = path.join(os.tmpdir(), `wox-qrcode-history-${Date.now()}.json`)

  afterAll(() => {
    fs.rmSync(historyFile, { force: true })
  })

  test("无文件时返回空数组", () => {
    expect(loadHistory(historyFile)).toEqual([])
  })

  test("追加记录：相同内容去重并提前，按最近使用排序", () => {
    appendHistory("first", new Date("2025-01-02T10:00:00"), 50, historyFile)
    appendHistory("second", new Date("2025-01-02T10:01:00"), 50, historyFile)
    appendHistory("first", new Date("2025-01-02T10:02:00"), 50, historyFile)

    const entries = loadHistory(historyFile)
    expect(entries.map(entry => entry.text)).toEqual(["first", "second"])
    expect(entries[0].createdAt).toBe(new Date("2025-01-02T10:02:00").getTime())
  })

  test("超过上限时淘汰最旧记录", () => {
    const limit = 3
    for (let index = 0; index < 5; index += 1) {
      appendHistory(`item-${index}`, new Date(2025, 0, 1, 0, index), limit, historyFile)
    }

    const entries = loadHistory(historyFile)
    expect(entries.length).toBe(3)
    expect(entries.map(entry => entry.text)).toEqual(["item-4", "item-3", "item-2"])
  })

  test("损坏的文件返回空数组", () => {
    fs.writeFileSync(historyFile, "{not json")
    expect(loadHistory(historyFile)).toEqual([])
  })

  test("removeHistory 仅删除指定记录", () => {
    fs.rmSync(historyFile, { force: true })
    appendHistory("a", new Date(2025, 0, 1), 50, historyFile)
    appendHistory("b", new Date(2025, 0, 2), 50, historyFile)

    removeHistory("a", historyFile)
    expect(loadHistory(historyFile).map(entry => entry.text)).toEqual(["b"])
  })

  test("clearHistory 清空全部记录", () => {
    appendHistory("a", new Date(2025, 0, 1), 50, historyFile)
    clearHistory(historyFile)
    expect(loadHistory(historyFile)).toEqual([])
  })
})

describe("formatHistoryTime", () => {
  const now = new Date(2025, 0, 2, 15, 30)

  test("今天显示时:分", () => {
    expect(formatHistoryTime(new Date(2025, 0, 2, 9, 5).getTime(), now)).toBe("今天 09:05")
  })

  test("昨天显示「昨天」", () => {
    expect(formatHistoryTime(new Date(2025, 0, 1, 23, 59).getTime(), now)).toBe("昨天 23:59")
  })

  test("更早显示完整日期", () => {
    expect(formatHistoryTime(new Date(2024, 11, 31, 8, 0).getTime(), now)).toBe("2024-12-31 08:00")
  })
})

describe("buildSaveFilePath", () => {
  const dir = path.join(os.tmpdir(), `wox-qrcode-save-${Date.now()}`)

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("生成带时间戳的文件名", () => {
    const filePath = buildSaveFilePath(dir, new Date(2025, 0, 2, 3, 4, 5))
    expect(path.basename(filePath)).toBe("qrcode_20250102_030405.png")
  })

  test("重名时追加序号", () => {
    fs.mkdirSync(dir, { recursive: true })
    const base = new Date(2025, 0, 2, 3, 4, 5)
    const first = buildSaveFilePath(dir, base)
    fs.writeFileSync(first, "")
    const second = buildSaveFilePath(dir, base)
    expect(second).toBe(`${first.replace(".png", "")}_1.png`)
  })
})
