import { describe, expect, it } from "vite-plus/test";

import {
  detectMachineKind,
  machineKindFromAppleProductName,
  machineKindFromDmi,
  type MachineProbe,
} from "../src/machine.ts";

/** A machine made of the given files and command outputs. */
function probe(
  platform: string,
  files: Record<string, string> = {},
  commands: Record<string, string> = {},
): MachineProbe & { readonly ran: string[] } {
  const ran: string[] = [];
  return {
    platform,
    ran,
    readFile: async (path) => files[path] ?? null,
    run: async (command, args) => {
      const line = [command, ...args].join(" ");
      ran.push(line);
      return commands[line] ?? null;
    },
  };
}

const dmi = (chassis: string, vendor = "LENOVO", product = "20XW") => ({
  "/sys/class/dmi/id/chassis_type": `${chassis}\n`,
  "/sys/class/dmi/id/sys_vendor": `${vendor}\n`,
  "/sys/class/dmi/id/product_name": `${product}\n`,
});

describe("machine kind detection", () => {
  it("reads a Linux machine's chassis type", async () => {
    expect(await detectMachineKind(probe("linux", dmi("10")))).toBe("laptop");
    expect(await detectMachineKind(probe("linux", dmi("3")))).toBe("desktop");
    expect(await detectMachineKind(probe("linux", dmi("23")))).toBe("server");
  });

  it("calls any virtual machine a cloud VM, whatever chassis its hypervisor reports", async () => {
    expect(await detectMachineKind(probe("linux", dmi("1", "QEMU", "Standard PC")))).toBe("cloud");
    expect(await detectMachineKind(probe("linux", dmi("3", "Hetzner", "vServer")))).toBe("cloud");
    expect(
      await detectMachineKind(probe("linux", dmi("3", "Microsoft Corporation", "Virtual Machine"))),
    ).toBe("cloud");
    // A Surface is Microsoft hardware, not a VM.
    expect(
      await detectMachineKind(probe("linux", dmi("9", "Microsoft Corporation", "Surface Laptop"))),
    ).toBe("laptop");
  });

  it("reads any product or vendor naming a hypervisor or cloud as a cloud VM, as T3 Code does", async () => {
    // Deliberately broad (T3's markers are substrings): a physical box sold as a "Cloud"
    // appliance reads as a cloud VM too, whatever its chassis. Its owner picks the kind then.
    expect(await detectMachineKind(probe("linux", dmi("3", "Acme", "CloudBox 500")))).toBe("cloud");
    expect(await detectMachineKind(probe("linux", dmi("17", "Xen", "HVM domU")))).toBe("cloud");
    expect(await detectMachineKind(probe("linux", dmi("10", "Acme", "KVM Laptop")))).toBe("cloud");
  });

  it("tells WSL by its kernel release before DMI, which says Hyper-V", async () => {
    const wsl = {
      ...dmi("3", "Microsoft Corporation", "Virtual Machine"),
      "/proc/sys/kernel/osrelease": "5.15.153.1-microsoft-standard-WSL2\n",
    };
    expect(await detectMachineKind(probe("linux", wsl))).toBe("linux");
  });

  it("knows nothing without DMI, or with a chassis type it does not map", async () => {
    expect(await detectMachineKind(probe("linux"))).toBeNull();
    expect(await detectMachineKind(probe("linux", dmi("2")))).toBeNull();
  });

  it("names a Mac by its product name, then by its model", async () => {
    const silicon = probe(
      "darwin",
      {},
      { "ioreg -rd1 -n product": '  "product-name" = <"Mac mini (2024)">\n' },
    );
    expect(await detectMachineKind(silicon)).toBe("mac-mini");
    expect(silicon.ran).toEqual(["ioreg -rd1 -n product"]);

    const intel = probe("darwin", {}, { "sysctl -n hw.model": "MacBookPro16,1\n" });
    expect(await detectMachineKind(intel)).toBe("laptop");
    expect(intel.ran).toEqual(["ioreg -rd1 -n product", "sysctl -n hw.model"]);

    expect(await detectMachineKind(probe("darwin"))).toBeNull();
  });

  it("does not guess on other platforms, or when the machine cannot be read", async () => {
    expect(await detectMachineKind(probe("win32", dmi("10")))).toBeNull();
    const failing: MachineProbe = {
      platform: "linux",
      readFile: () => Promise.reject(new Error("EACCES")),
      run: () => Promise.reject(new Error("ENOENT")),
    };
    expect(await detectMachineKind(failing)).toBeNull();
  });

  it("maps Apple product names and DMI fields as T3 Code does", () => {
    expect(machineKindFromAppleProductName("Mac Studio (2023)")).toBe("mac-studio");
    expect(machineKindFromAppleProductName("iMac24,1")).toBe("desktop");
    expect(machineKindFromAppleProductName("MacPro7,1")).toBe("desktop");
    expect(machineKindFromAppleProductName("ThinkPad")).toBeNull();
    expect(
      machineKindFromDmi({ chassisType: null, sysVendor: "Apple Inc.", productName: "Macmini9,1" }),
    ).toBe("mac-mini");
  });
});
