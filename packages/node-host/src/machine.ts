// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/environment/ServerEnvironmentMachine.ts — which machine a server runs on,
// from DMI on Linux and the product name on macOS. Effect is replaced by plain promises.
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs/promises";

import type { MachineKind } from "@jhin/host-api";

const DMI_ROOT = "/sys/class/dmi/id";
const KERNEL_RELEASE_PATH = "/proc/sys/kernel/osrelease";
const PROBE_TIMEOUT_MS = 5_000;

// SMBIOS 3.x System Enclosure types (table 17).
const DMI_CHASSIS_KINDS: Readonly<Record<string, MachineKind>> = {
  "3": "desktop",
  "4": "desktop",
  "5": "desktop",
  "6": "desktop",
  "7": "desktop",
  "8": "laptop",
  "9": "laptop",
  "10": "laptop",
  "13": "desktop",
  "14": "laptop",
  "15": "desktop",
  "16": "desktop",
  "17": "server",
  "18": "server",
  "19": "server",
  "20": "server",
  "21": "server",
  "22": "server",
  "23": "server",
  "24": "server",
  "28": "server",
  "31": "laptop",
  "32": "laptop",
  "35": "desktop",
};

// Hypervisors and cloud providers write themselves into the DMI vendor or
// product strings; any hit means the box is a VM, and a VM reads as "cloud"
// regardless of the chassis type the hypervisor fakes. Hyper-V is matched on
// its "Virtual Machine" product, not the "Microsoft Corporation" vendor that
// physical Surface devices share.
const VIRTUALIZATION_MARKERS = [
  "qemu",
  "kvm",
  "bochs",
  "vmware",
  "virtualbox",
  "innotek",
  "xen",
  "parallels",
  "amazon ec2",
  "google compute engine",
  "digitalocean",
  "hetzner",
  "linode",
  "vultr",
  "scaleway",
  "openstack",
  "cloud",
  "virtual machine",
];

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

export function machineKindFromAppleProductName(name: string): MachineKind | null {
  const normalized = name.trim().toLowerCase().replaceAll(/\s+/g, "");
  if (normalized.startsWith("macmini")) return "mac-mini";
  if (normalized.startsWith("macstudio")) return "mac-studio";
  if (normalized.startsWith("macbook")) return "laptop";
  if (normalized.startsWith("imac") || normalized.startsWith("macpro")) return "desktop";
  return null;
}

export function machineKindFromDmi(input: {
  readonly chassisType: string | null;
  readonly sysVendor: string | null;
  readonly productName: string | null;
}): MachineKind | null {
  const productName = input.productName ?? "";
  const vendorAndProduct = `${input.sysVendor ?? ""} ${productName}`.toLowerCase();
  if (VIRTUALIZATION_MARKERS.some((marker) => vendorAndProduct.includes(marker))) return "cloud";
  const appleKind = machineKindFromAppleProductName(productName);
  if (appleKind !== null) return appleKind;
  return input.chassisType === null ? null : (DMI_CHASSIS_KINDS[input.chassisType] ?? null);
}

/** What detection reads from the machine; tests give their own. */
export interface MachineProbe {
  /** Node's `process.platform`. */
  readonly platform: string;
  /** The file's text, or `null` when it cannot be read. */
  readFile(path: string): Promise<string | null>;
  /** The command's output when it exits with 0, else `null`. */
  run(command: string, args: readonly string[]): Promise<string | null>;
}

// IOKit's `product` node carries the marketing name ("Mac mini (2024)") on
// Apple silicon; Intel Macs lack it, so `hw.model` ("Macmini8,1") is the
// fallback.
async function detectDarwin(probe: MachineProbe): Promise<MachineKind | null> {
  const ioreg = normalize(await probe.run("ioreg", ["-rd1", "-n", "product"]));
  const productName = ioreg?.match(/"product-name"\s*=\s*<"([^"]+)">/)?.[1] ?? null;
  const fromProductName =
    productName === null ? null : machineKindFromAppleProductName(productName);
  if (fromProductName !== null) return fromProductName;
  const model = normalize(await probe.run("sysctl", ["-n", "hw.model"]));
  return model === null ? null : machineKindFromAppleProductName(model);
}

async function detectLinux(probe: MachineProbe): Promise<MachineKind | null> {
  const [kernelRelease, chassisType, sysVendor, productName] = (
    await Promise.all([
      probe.readFile(KERNEL_RELEASE_PATH),
      probe.readFile(`${DMI_ROOT}/chassis_type`),
      probe.readFile(`${DMI_ROOT}/sys_vendor`),
      probe.readFile(`${DMI_ROOT}/product_name`),
    ])
  ).map(normalize);
  // WSL exposes Microsoft in its kernel release on both WSL 1 and WSL 2.
  // Check it before DMI because WSL 2 presents as a Hyper-V VM.
  if (kernelRelease?.toLowerCase().includes("microsoft")) return "linux";
  return machineKindFromDmi({
    chassisType: chassisType ?? null,
    sysVendor: sysVendor ?? null,
    productName: productName ?? null,
  });
}

/** The machine kind the node can tell by itself; `null` when it cannot (Windows, no DMI). */
export async function detectMachineKind(probe: MachineProbe): Promise<MachineKind | null> {
  try {
    switch (probe.platform) {
      case "darwin":
        return await detectDarwin(probe);
      case "linux":
        return await detectLinux(probe);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Reads this machine. */
export const systemProbe: MachineProbe = {
  platform: process.platform,
  readFile: (path) => Fs.readFile(path, "utf8").catch(() => null),
  run: (command, args) =>
    new Promise((resolve) => {
      ChildProcess.execFile(
        command,
        [...args],
        { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
        (error, stdout) => resolve(error === null ? stdout : null),
      );
    }),
};
