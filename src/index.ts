import * as execa from 'execa';
import { promises as fs } from 'fs';
import * as path from 'path';

namespace util {
  export function reportListStatistics<S>(arr: S[], pred: (arg: S) => any): { [k: string]: number } {
    const result: { [k: string]: number } = {};
    for (const arg of arr) {
      const key = `${pred(arg)}`;
      result[key] = (result[key] || 0) + 1;
    }
    return result;
  }

  // For use in reduce()
  export function flatten<T>(arr: T[], e: T[]) {
    arr.push(...e);
    return arr;
  }

  // For use in reduce()
  export function removeDuplicates<T>(arr: T[], e: T) {
    if (arr.indexOf(e) === -1) {
      arr.push(e);
    }
    return arr;
  }

  export function arrayEquals<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }
}

namespace gn {
  interface GnTarget {
    deps: string[];
    type: string;
    include_dirs?: string[];
    defines?: string[];
    sources?: string[];
    toolchain?: string;
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
  
  export interface GnAllDescriptions {
    [build: string]: GnDescription;
  }

  interface GypAction {
    action_name: string;
    inputs: string[];
    outputs: string[];
    action: string[];
  }
  
  interface GypFields {
    toolsets?: string[];
    target_conditions?: Array<[string, GypFields]>;
    include_dirs?: string[];
    dependencies?: string[];
    defines?: string[];
    sources?: string[];
    actions?: GypAction[];
    link_settings?: {
      libraries?: string[];
    }
    cflags?: string[];
    cflags_cc?: string[];
    hard_dependency?: string;
  }

  interface GypTarget extends GypFields {
    target_name: string;
    type: string;
  }

  class GypTargetBuilder {
    private readonly targetFragments = new Map<string, GypFields & { outputs?: string[] }>();

    constructor(
      readonly targetName: string,
      readonly targetType: string) {}

    setForToolchain(toolchain: string, fragment: GypFields, outputs?: string[]) {
      if (fragment.target_conditions) {
        throw new Error(`Individual toolchain config shouldn't have its own target conditions: ${toolchain}, ${fragment.target_conditions}`);
      }
      this.targetFragments.set(toolchain, Object.assign({ outputs }, fragment));
    }

    private buildTarget(): GypTarget {
      const builds = Array.from(this.targetFragments.keys());
      let result: GypTarget = {
        target_name: this.targetName,
        type: this.targetType
      };
      result.toolsets = builds;
      if (builds.length === 1) {
        result = Object.assign({}, this.targetFragments.get(builds[0])!, result);
        delete (result as any).outputs;
      } else {
        const deps: string[] = [];
        {
          let depsSet = false;
          builds.forEach(build => {
            const toolchainAgnosticDeps = (this.targetFragments.get(build)!.dependencies || []).map(dependency => {
              const sameBuildSuffix = `#${build}`;
              if (!dependency.endsWith(sameBuildSuffix)) {
                throw new Error(`${this.targetName} for ${build} toolchain has a non-${build} dependency`);
              }
              return dependency.slice(0, dependency.length - sameBuildSuffix.length);
            });
            if (!depsSet) {
              deps.push(...toolchainAgnosticDeps);
            } else {
              if (!util.arrayEquals(deps, toolchainAgnosticDeps)) {
                throw new Error(`${this.targetName} has different dependencies for different toolchains`);
              }
            }
            depsSet = true;
          });
        }
        result.target_conditions = builds.map(build => {
          const targetForBuild = Object.assign({}, this.targetFragments.get(build)!);
          delete targetForBuild.dependencies;
          delete targetForBuild.outputs;
          return [`_toolset=="${build}"`, targetForBuild] as [string, GypFields]
        });
        result.dependencies = deps;
      }
      return result;
    }

    private buildProxy(): GypTarget {
      if (this.targetType !== 'executable') {
        throw new Error('Proxies only make sense for executables');
      }
      const builds = Array.from(this.targetFragments.keys());
      const actionsForBuilds: GypFields[] = builds.map(build => {
        const outputs = this.targetFragments.get(build)!.outputs;
        if (!outputs || outputs.length !== 1) {
          throw new Error(`${this.targetName} as an executable should have just one output`);
        }
        return {
          actions: [
            {
              action_name: `move_as_expected_output`,
              action: [
                'cp',
                '<@(_inputs)',
                '<@(_outputs)',
              ],
              inputs: [`<@(PRODUCT_DIR)/${this.targetName}_proxy`],
              outputs: [outputs[0]]
            }
          ]
        };
      });
      const result: GypTarget = {
        target_name: this.targetName,
        type: 'none',
        dependencies: [`${this.targetName}_proxy`],
        toolsets: builds
      };
      if (builds.length === 1) {
        Object.assign(result, actionsForBuilds[0]);
      } else {
        result.target_conditions = actionsForBuilds.map((actionForBuild, i) => {
          return [`_toolset=="${builds[i]}"`, actionForBuild] as [string, GypFields]
        });
      }
      return result;
    }

    buildWithProxy(): GypTarget[] {
      const mainTarget = this.buildTarget();
      if (this.targetType === 'executable') {
        mainTarget.target_name = `${this.targetName}_proxy`;
        const proxyTarget = this.buildProxy();
        return [mainTarget, proxyTarget];
      } else {
        return [mainTarget];
      }
    }
  }
  
  interface GypFile {
    targets: Array<GypTarget>;
  }

  export async function createAllDescriptions(cwd: string): Promise<GnAllDescriptions> {
    // const builds = await fs.readdir(`${cwd}/out`);
    const builds = ['mac_debug', 'mac_release'];
    const descs = await Promise.all(builds.map((build) => createDescription(cwd, build)));
    const result: GnAllDescriptions = {};
    for (let i = 0; i < builds.length; i++) {
      result[builds[i]] = descs[i];
    }
    return result;
  }

  async function createDescription(cwd: string, build: string): Promise<GnDescription> {
    const knownTargets: Map<string, Promise<GnDescription>> = new Map();
    const getSingleTarget = async (target: string): Promise<GnDescription> => {
      if (knownTargets.has(target)) {
        return knownTargets.get(target)!;
      }
      const desc = (async () => {
        const output = await execa.stdout('gn', ['desc', `out/${build}`, target, '--all-toolchains', '--format=json'], { cwd });
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
  }

  /**
   * Given a GN target name, create a reasonable GYP target name.
   * @param target 
   */
  function gypifyTargetName(target: string): { target: string, toolchain: string } {
    let toolchain = 'target';
    if (target.indexOf('(') !== -1) {
      target = target.slice(0, target.indexOf('('));
      toolchain = 'host';
    }
    target = target.slice(2);
    target = target.replace(':', '_');
    while (target.indexOf('/') !== -1) {
      target = target.replace('/', '_');
    }
    while (target.indexOf('+') !== -1) {
      target = target.replace('+', '_');
    }
    return { target, toolchain };
  }

  /**
   * Given a GN target type, return a corresponding GYP target type.
   * @param gnType The GN type.
   */
  function gypifyTargetType(gnType: string): string {
    switch (gnType) {
      case 'source_set':
        // In the GN docs, a source set is a "virtual static library", where no
        // real output is produced. In GYP this should be equivalent, even
        // though we do produce an output so it would be expected that this is
        // slower.
        return 'static_library';
      case 'group':
      case 'action':
      case 'action_foreach':
      case 'copy':
        // Caller is responsible for replicating the associated action in
        // question, if there is one.
        return 'none';
      default:
        return gnType;
    }
  }

  /**
   * Given a list of C flags, extract the include directories.
   * @param cflags A list of C flags.
   */
  function extractIncludes(cflags: string[]): string[] {
    const result = [];
    for (let i = 0; i < cflags.length; i++) {
      if (cflags[i].match(/^-[Ii]/)) {
        if (i + 1 === cflags.length) {
          throw new Error(`Unexpected value for last cflag: ${cflags[i]}`);
        }
        // Every include seems to be relative to a two-level deep directory.
        // For the purposes of building, lop one layer of depth off.
        result.push(cflags[i + 1].slice('../'.length));
      }
    }
    return result;
  }

  export function createGypFile(target: string, allDescs: GnAllDescriptions): GypFile {
    const build = 'mac_debug';
    const desc = allDescs[build];
    const result = new Map<string, GypTargetBuilder>();

    // Create a dummy empty.cc file action.
    const emptyCCTarget = new GypTargetBuilder('gen_empty_cc', 'none');
    for (const toolchain of ['host', 'target']) {
      emptyCCTarget.setForToolchain(toolchain, {
        actions: [
          {
            action_name: 'gen_empty_cc_action',
            inputs: [],
            outputs: ['<(SHARED_INTERMEDIATE_DIR)/empty.cc'],
            action: ['touch', '<(SHARED_INTERMEDIATE_DIR)/empty.cc']
          }
        ]
      });
    }
    result.set('gen_empty_cc', emptyCCTarget);

    const canonicalizePath = (p: string): string => {
      const outPrefix = `//out/${build}/`;
      if (p.startsWith(outPrefix)) {
        return `<(SHARED_INTERMEDIATE_DIR)/${p.slice(outPrefix.length)}`;
      } else if (p.startsWith('//')) {
        return `../${p.slice(2)}`;
      }
      throw new Error(`Unexpected path: ${p}`);
    }

    // specific for Perfetto
    function correctPathsForScriptArgs(script: string, args: string[]): string[] {
      if (script === '//gn/standalone/build_tool_wrapper.py') {
        return args.map(arg => {
          if (arg.startsWith('../')) {
            return arg.slice(3);
          } else if (arg.startsWith('--')) {
            arg = arg.replace(/^(--plugin=protoc-gen-plugin=)(.*)$/, `$1<(SHARED_INTERMEDIATE_DIR)/$2`);
            arg = arg.replace(/^(--plugin_out=.*):(.*)$/, `$1:<(SHARED_INTERMEDIATE_DIR)/$2`);
            return arg;
          } else {
            const p = `//${path.join(`out/${build}`, arg)}`;
            return canonicalizePath(p);
          }
        })
      } else {
        throw new Error('unknown script ' + script);
      }
    }

    // gnTargets is the queue of targets that still need to be created.
    const gnTargets = [target];
    while (gnTargets.length > 0) {
      // Pop the head of the queue.
      const gnTargetName = gnTargets.shift()!;
      // Get the GN target description for this target.
      const gnTarget = desc[gnTargetName];
      if (!gnTarget) {
        throw new Error(`No value in desc under ${gnTargetName}`);
      }
      // Get its dependencies.
      // TODO: Sometimes deps don't actually get run, and have to be make'd individually. Figure out why.
      const deps = (gnTarget.deps || []);
      // For dependencies that have not yet been processed, add them to the
      // queue to be processed later.
      gnTargets.push(...deps.filter(dep => {
        return !gnTargets.some(target => target === dep);
      }));
      // Create the list of include dirs.
      const includeDirs: string[] = [
        ...(gnTarget.include_dirs || []).map(canonicalizePath),
        ...extractIncludes(gnTarget.cflags || [])
      ].reduce(util.removeDuplicates, [] as string[]);
      // Create the corresponding GYP target.
      const {
        target: targetName,
        toolchain: targetToolchain
      } = gypifyTargetName(gnTargetName);
      const targetType = gypifyTargetType(gnTarget.type);
      const gypFields: GypFields = {
        include_dirs: includeDirs,
        defines: gnTarget.defines || [],
        // empty.cc is here to satisfy the linker if there are no cc files.
        // TODO Make this more robust.
        sources: (gnTarget.sources || []).map(canonicalizePath),
        dependencies: deps.map(gypifyTargetName).map(dep => `${dep.target}#${dep.toolchain}`),
        cflags: gnTarget.cflags || [],
        cflags_cc: gnTarget.cflags_cc || [],
        // Static libraries cannot depend on each other in GYP unless this flag
        // is set to true.
        hard_dependency: 'True'
      };
      if (targetType === 'static_library') {
        gypFields.sources!.push('<(SHARED_INTERMEDIATE_DIR)/empty.cc');
        gypFields.dependencies!.push(`gen_empty_cc#${targetToolchain}`);
      }
      // Apparently libs not allowed in DEBUG.
      // if (gnTarget.libs) {
      //   gypFields.link_settings = {
      //     libraries: gnTarget.libs.map(l => `-l${l}`)
      //   };
      // }
      // If it exists, attach a GYP action.
      switch (gnTarget.type) {
        case 'action': {
          if (!gnTarget.script) {
            throw new Error(`${gnTargetName} is an action but has no script`);
          }
          const metaInputs = [
            ...(gnTarget.inputs || []),
            ...(gnTarget.sources || [])
          ];
          gypFields.actions = [{
            action_name: `${targetName}_action`,
            inputs: metaInputs.map(canonicalizePath),
            outputs: (gnTarget.outputs || []).map(canonicalizePath),
            action: [
              ...(gnTarget.script.endsWith('.py') ? ['python'] : []),
              canonicalizePath(gnTarget.script!),
              ...correctPathsForScriptArgs(gnTarget.script, gnTarget.args || [])
            ]
          }];
          break;
        }
        case 'action_foreach': {
          throw new Error(`action_foreach is untested`);
          // const metaInputs = [
          //   ...(gnTarget.inputs || []),
          //   ...(gnTarget.sources || [])
          // ];
          // gypTarget.actions = [
          //   ...metaInputs.map((input, num) => ({
          //     action_name: `${gypTarget.target_name}_action_${num}`,
          //     inputs: [canonicalizePath(input)],
          //     outputs: [],
          //     action: [
          //       canonicalizePath(gnTarget.script!),
          //       ...(gnTarget.args || [])
          //     ]
          //   })),
          //   {
          //     action_name: `${gypTarget.target_name}_action_final`,
          //     inputs: [],
          //     outputs: (gnTarget.outputs || []).map(canonicalizePath),
          //     action: []
          //   }
          // ];
          // break;
        }
        case 'copy': {
          gypFields.actions = [{
            action_name: `${targetName}_action`,
            inputs: (gnTarget.sources || []).map(canonicalizePath),
            outputs: (gnTarget.outputs || []).map(canonicalizePath),
            action: [
              'cp',
              '<@(_inputs)',
              '<@(_outputs)'
            ]
          }];
          break;
        }
      }
      // Put it in our result.
      if (!result.has(targetName)) {
        result.set(targetName, new GypTargetBuilder(targetName, targetType));
      } else if (targetType !== result.get(targetName)!.targetType) {
        throw new Error(`Mismatched types for a target with multiple toolchains`);
      }
      result.get(targetName)!.setForToolchain(targetToolchain, gypFields, (gnTarget.outputs || []).map(canonicalizePath));
    }
    return {
      targets: Array.from(result.values()).map(builder => builder.buildWithProxy())
        .reduce(util.flatten)
    };
  }
}

async function main(args: string[]) {
  const perfettoDir = process.env.PERFETTO_PATH;
  if (!perfettoDir) {
    throw new Error(`Please define $PERFETTO_PATH`);
  }

  // Get GN build descriptions (or generate them if not cached)
  let allDescs: gn.GnAllDescriptions;
  if (!(await fs.stat('all.json'))) {
    allDescs = await gn.createAllDescriptions(perfettoDir);
    await fs.writeFile('all.json', JSON.stringify(allDescs, null, 2));
  } else {
    allDescs = JSON.parse(await fs.readFile('all.json', 'utf8'));
  }

  // Run a query (?)
  for (const build of ['debug', 'release']) {
    const targets = Object.keys(allDescs[`mac_${build}`])
      .map(k => allDescs[`mac_${build}`][k]);
    console.log(build, util.reportListStatistics(
      targets,
        // .filter(a => a.type === 'source_set'),
      a => a.script
    ));
  }

  // Write the gyp file
  const result = gn.createGypFile('//:libperfetto', allDescs);
  await fs.writeFile(`${perfettoDir}/gypfiles/perfetto.gyp`, JSON.stringify(result, null, 2));

  const lib = 'perfetto';
  await execa('./tools/gyp/gyp', [
    '-f',
    'make',
    `/Users/kelvinjin/src/node-ci/node-ci/node/deps/${lib}/gypfiles/${lib}.gyp`,
    '-I',
    '/Users/kelvinjin/src/node-ci/node-ci/node/common.gypi',
    '-I',
    '/Users/kelvinjin/src/node-ci/node-ci/node/config.gypi',
    '--depth=.',
    '--generator-output',
    '/Users/kelvinjin/src/node-ci/node-ci/node/out',
    '-Goutput_dir=/Users/kelvinjin/src/node-ci/node-ci/node/out',
    '-Dcomponent=static_library',
    '-Dlibrary=static_library',
    '-Dlinux_use_bundled_binutils=0',
    '-Dlinux_use_bundled_gold=0',
    '-Dlinux_use_gold_flags=0'
  ], {
    stdio: 'inherit'
  });
}

main(process.argv.slice(2)).catch(console.error);
// need to pull in empty files sometimes.