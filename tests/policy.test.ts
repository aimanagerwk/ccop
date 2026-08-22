import { describe, expect, it } from "vitest";
import { bashDenied, decide, loadPolicy } from "../src/policy.js";

describe("policy", () => {
  it("allow Read Grep Glob", () => {
    for (const t of ["Read", "Grep", "Glob"]) {
      expect(decide(t, { file_path: "/tmp/x" })).toBe("allow");
    }
  });

  it("ask Write Edit Bash safe", () => {
    expect(decide("Write", { file_path: "/workspace/hello-cc/hello.py" })).toBe("ask");
    expect(decide("Edit", { file_path: "/workspace/hello-cc/hello.py" })).toBe("ask");
    expect(decide("Bash", { command: "python3 hello.py" })).toBe("ask");
    expect(decide("AskUserQuestion", { questions: [] })).toBe("ask");
  });

  it("deny rm -rf root", () => {
    expect(decide("Bash", { command: "rm -rf /" })).toBe("deny");
    expect(decide("Bash", { command: "echo hi; rm -rf / && true" })).toBe("deny");
    expect(bashDenied("rm -rf /")).toBeTruthy();
  });

  it("deny sudo", () => {
    expect(decide("Bash", { command: "sudo apt-get update" })).toBe("deny");
    expect(bashDenied("sudo reboot")).toBeTruthy();
  });

  it("deny write etc usr", () => {
    expect(decide("Bash", { command: "echo x > /etc/passwd" })).toBe("deny");
    expect(decide("Bash", { command: "echo x >> /usr/bin/evil" })).toBe("deny");
    expect(decide("Bash", { command: "tee /etc/cron.d/x" })).toBe("deny");
    expect(decide("Bash", { command: "cp foo /usr/local/bin/x" })).toBe("deny");
  });

  it("safe bash not denied", () => {
    expect(bashDenied("python3 hello.py")).toBeNull();
    expect(bashDenied("ls /usr")).toBeNull();
    expect(decide("Bash", { command: "ls /usr" })).toBe("ask");
  });

  it("load policy file", () => {
    const pol = loadPolicy();
    expect(pol.allow).toContain("Read");
  });
});
