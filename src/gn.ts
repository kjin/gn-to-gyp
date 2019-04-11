import {deserializeMap, flatten, removeDuplicates, serializeMap} from './util';

import execa = require('execa');
import {promises as fs} from 'fs';

/**
 * A string assumed to always exist in a project as the top-level target name.
 */
const TARGET_ALL = '//:all';

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

/**
 * The shape of a JSON object output by `gn desc --format=json`.
 */
interface GnDescription {
  [target: string]: GnTarget;
}

/**
 * Components in a GN target name.
 */
export interface ParsedGnTargetName {
  path: string;
  target: string;
  toolchain: string;
}

/**
 * Given a GN target name, return its parsed components, or throw if the target
 * name isn't as expected.
 * @param targetName The target name to parse.
 */
export function parseGnTargetName(targetName: string): ParsedGnTargetName {
  const match = targetName.match(/^\/\/([^:]*):([^:]*)(?:\((.*)\))?$/);
  if (!match) {
    throw new Error(
        `A target name doesn't match the expected regex: ${targetName}`);
  }
  const [_, file, target, toolchain] = match;
  return {path: file, target, toolchain};
}

/**
 * A class that represents the collection of targets in a single build (out/*).
 */
export class GnBuild {
  private targets = new Map<string, GnTarget>();
  private toolchains: string[] = [];
  private defaultToolchain = '';

  private constructor() {}

  /**
   * Given a toolchain and target name, return the corresponding target, or
   * throw if no such target exists.
   * @param toolchain The toolchain with which the target will be built.
   * @param targetName The target name.
   */
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

  /**
   * Get a list of all target names.
   * TODO(kjin): YAGNI (verify this).
   */
  getTargetNames(): string[] {
    return Array.from(this.targets.keys());
  }

  /**
   * Get a list of all toolchains.
   */
  getToolchains(): string[] {
    return this.toolchains;
  }

  /**
   * Get the "default" toolchain (when a target is described without a toolchain
   * as part of its fully qualified name).
   */
  getDefaultToolchain(): string {
    return this.defaultToolchain;
  }

  /**
   * Create an instance of this class from a string.
   * @param json The string from which to deserialize.
   */
  static deserialize(json: string): GnBuild {
    const result = new GnBuild();
    result.targets =
        deserializeMap(json, k => k, v => JSON.parse(v) as GnTarget);
    result.toolchains =
        Array.from(result.targets.values()).map(target => target.toolchain);
    // Assume that TARGET_ALL is always built with target toolchain.
    if (!result.targets.has(TARGET_ALL)) {
      throw new Error(`GnBuild has no ${TARGET_ALL} target`);
    }
    result.defaultToolchain = result.targets.get(TARGET_ALL)!.toolchain;
    return result;
  }

  /**
   * Create a string from an instance of this class.
   * @param gnBuild The instance to serialize.
   */
  static serialize(gnBuild: GnBuild): string {
    return serializeMap(gnBuild.targets, k => k, v => JSON.stringify(v));
  }
}

/**
 * A class that represents all possible builds in a GN project.
 */
export class GnProject {
  private builds = new Map<string, GnBuild>();

  private constructor() {}

  /**
   * Get a list of all builds.
   */
  getBuildNames(): string[] {
    return Array.from(this.builds.keys());
  }

  /**
   * Get a GnBuild instance under the given name, or throw if one doesn't exist.
   * @param buildName The build name to look up.
   */
  getBuild(buildName: string): GnBuild {
    if (!this.builds.has(buildName)) {
      throw new Error(`Build ${buildName} not found`);
    }
    return this.builds.get(buildName)!;
  }

  /**
   * Get a list of all target names across all builds.
   * TODO(kjin): YAGNI (verify this).
   */
  getTargetNames(): string[] {
    return Array.from(this.builds.values())
        .map(target => Array.from(target.getTargetNames()))
        .reduce(flatten, [] as string[])
        .reduce(removeDuplicates, [] as string[]);
  }

  /**
   * Create an instance of this class from a string.
   * @param json The string from which to deserialize.
   */
  static deserialize(json: string): GnProject {
    const result = new GnProject();
    result.builds = deserializeMap(json, k => k, GnBuild.deserialize);
    return result;
  }

  /**
   * Create a string from an instance of this class.
   * @param gnProject The instance to serialize.
   */
  static serialize(gnProject: GnProject): string {
    return serializeMap(gnProject.builds, k => k, GnBuild.serialize);
  }

  /**
   * Create an instance of this class from a directory that contains a GN
   * project.
   * TODO(kjin): Assumes that GN build files have already been built.
   * @param projectDir The directory that contains the GN project.
   * @param builds A list of builds to process. Builds typically correspond to
   * directory names in the out/ directory. Omit or pass a falsy value to
   * search out/ for builds to process.
   */
  static async fromDirectory(projectDir: string, builds?: string[]):
      Promise<GnProject> {
    // If no builds provided, search the out/ directory.
    if (!builds) {
      builds = await fs.readdir(`${projectDir}/out`);
    }
    // Get descriptions for all builds in parallel.
    const gnDescs = await Promise.all(builds.map(async (build) => {
      // A map containing all targets.
      const knownTargets: Map<string, Promise<GnDescription>> = new Map();
      // Helper function -- get the `gn desc` for a single target and
      // dependencies, populating knownTargets, which also doubles as a cache.
      const getSingleTarget = async(target: string): Promise<GnDescription> => {
        // Don't do any extra processing if we've already seen the target
        // before.
        if (knownTargets.has(target)) {
          return knownTargets.get(target)!;
        }
        const desc = (async () => {
          // The actual call to `gn desc`.
          const output = await execa.stdout(
              'gn',
              [
                'desc', `out/${build}`, target, '--all-toolchains',
                '--format=json'
              ],
              {cwd: projectDir});
          const desc: GnDescription = JSON.parse(output);
          return desc;
        })();
        // Save the pending target description into the cache.
        // We save the pending description instead of the resolve one so that
        // we don't do redundant async work.
        knownTargets.set(target, desc);
        // Wait until all dependents have been resolved.
        await Promise.all((await desc)[target].deps.map(getSingleTarget));
        return desc;
      };
      // Call the above mentioned helper function for the top-level target,
      // assumed to be TARGET_ALL.
      await getSingleTarget(TARGET_ALL);
      // In practice all pending promises in knownTargets should have been
      // resolved in the previous call -- the await here should be near-
      // immediate.
      const allTargets = await Promise.all(Array.from(knownTargets.values()));
      // allTargets looks like [{ a: x }, { b: y }] (and might be in any
      // order.
      // Sort and merge these objects together so we get something like
      // { a: x, b: y }.
      return allTargets
          .sort((a, b) => Object.keys(a)[0].localeCompare(Object.keys(b)[0]))
          .reduce((acc, next) => {
            return Object.assign(acc, next);
          }, {});
    }));
    // All builds have been described.
    const result = new GnProject();
    for (let i = 0; i < builds.length; i++) {
      result.builds.set(
          builds[i], GnBuild.deserialize(JSON.stringify(gnDescs[i])));
    }
    return result;
  }
}
