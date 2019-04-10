import { removeDuplicates, flatten, deserializeMap, serializeMap } from "./util";
import execa = require("execa");

/**
 * A description of a GN build target.
 */
export interface GnTarget {
  deps: string[];
  type: string;
  toolchain: string;
  include_dirs?: string[];
  defines?: string[];
  sources?: string[];
  inputs?: string[];
  outputs?: string[];
  args?: string[];
  script?: string;
  libs?: string[];
  cflags?: string[];
  cflags_cc?: string[];
}

interface GnDescription {
  [target: string]: GnTarget;
}

export interface ParsedGnTargetName {
  file: string;
  target: string;
  toolchain: string;
}

export function parseGnTargetName(targetName: string): ParsedGnTargetName {
  const match = targetName.match(/^\/\/([^:]*):([^:]*)(?:\((.*)\))?$/);
  if (!match) {
    throw new Error(
      `A target name doesn't match the expected regex: ${targetName}`);
  }
  const [_, file, target, toolchain] = match;
  return { file, target, toolchain };
}

class GnBuild {
  private targets = new Map<string, GnTarget>();
  private toolchains: string[] = [];
  private defaultToolchain: string = '';

  getTarget(toolchain: string, targetName: string): GnTarget {
    let result;
    if (toolchain === this.defaultToolchain) {
      result = this.targets.get(targetName);
    } else {
      result = this.targets.get(`${targetName}(${toolchain})`);
    }
    if (!result) {
      throw new Error(`No target ${targetName} with toolchain ${toolchain}`);
    }
    return result;
  }

  getTargetNames(): string[] {
    return Array.from(this.targets.keys());
  }

  getToolchains(): string[] {
    return this.toolchains;
  }

  getDefaultToolchain(): string {
    return this.defaultToolchain;
  }

  static deserialize(json: string): GnBuild {
    const result = new GnBuild();
    result.targets = deserializeMap(json, k => k, v => JSON.parse(v) as GnTarget);
    result.toolchains = Array.from(result.targets.values())
      .map(target => target.toolchain);
    // Assume that //:all is always built with target toolchain.
    if (!result.targets.has('//:all')) {
      throw new Error('GnBuild has no //:all target');
    }
    result.defaultToolchain = result.targets.get('//:all')!.toolchain;
    return result;
  }

  static serialize(gnBuild: GnBuild): string {
    return serializeMap(gnBuild.targets, k => k, v => JSON.stringify(v));
  }
}

export class GnProject {
  private builds = new Map<string, GnBuild>();

  private constructor() {}

  getBuildNames(): string[] {
    return Array.from(this.builds.keys());
  }

  getBuild(buildName: string): GnBuild {
    if (!this.builds.has(buildName)) {
      throw new Error(`Build ${buildName} not found`);
    }
    return this.builds.get(buildName)!;
  }

  getTargetNames(): string[] {
    return Array.from(this.builds.values())
      .map(target => Array.from(target.getTargetNames()))
      .reduce(flatten, [] as string[])
      .reduce(removeDuplicates, [] as string[]);
  }

  static deserialize(json: string): GnProject {
    const result = new GnProject();
    result.builds = deserializeMap(json, k => k, GnBuild.deserialize);
    return result;
  }

  static serialize(gnProject: GnProject): string {
    return serializeMap(gnProject.builds, k => k, GnBuild.serialize);
  }

  static async fromDirectory(perfettoDir: string, builds: string[]): Promise<GnProject> {
    const gnDescs = await Promise.all(builds.map(async (build) => {
      const knownTargets: Map<string, Promise<GnDescription>> = new Map();
      const getSingleTarget = async (target: string): Promise<GnDescription> => {
        if (knownTargets.has(target)) {
          return knownTargets.get(target)!;
        }
        const desc = (async () => {
          const output = await execa.stdout('gn', ['desc', `out/${build}`, target, '--all-toolchains', '--format=json'], { cwd: perfettoDir });
          const desc: GnDescription = JSON.parse(output);
          return desc;
        })();
        knownTargets.set(target, desc);
        await Promise.all((await desc)[target].deps.map(getSingleTarget));
        return desc;
      }
      await getSingleTarget('//:all');
      const allTargets = await Promise.all(Array.from(knownTargets.values()));
      return allTargets
        .sort((a, b) => Object.keys(a)[0].localeCompare(Object.keys(b)[0]))
        .reduce((acc, next) => {
          return Object.assign(acc, next);
        }, {});
    }));
    const result = new GnProject();
    for (let i = 0; i < builds.length; i++) {
      result.builds.set(builds[i], GnBuild.deserialize(JSON.stringify(gnDescs[i])));
    }
    return result;
  }
}
