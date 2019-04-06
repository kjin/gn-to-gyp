import * as execa from 'execa';
import { promises as fs } from 'fs';

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
  export function removeDuplicates<S>(arr: S[], e: S) {
    if (arr.indexOf(e) === -1) {
      arr.push(e);
    }
    return arr;
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
  
  interface GypTarget {
    target_name: string;
    type: string;
    dependencies?: string[];
    include_dirs?: string[];
    defines?: string[];
    sources?: string[];
    actions?: GypAction[];
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

  function gypifyTargetName(target: string): string {
    if (target.indexOf('(') !== -1) {
      target = target.slice(0, target.indexOf('('));
    }
    target = target.slice(2);
    target = target.replace(':', '_');
    while (target.indexOf('/') !== -1) {
      target = target.replace('/', '_');
    }
    while (target.indexOf('+') !== -1) {
      target = target.replace('+', '_');
    }
    return target;
  }

  function gypifyTargetType(type: string): string {
    switch (type) {
      case 'source_set':
      case 'group':
      case 'action':
      case 'action_foreach':
      case 'copy':
        return 'none';
      default:
        return type;
    }
  }

  export function createGypFile(target: string, desc: GnDescription): GypFile {
    const result: GypFile = {
      targets: []
    };
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
      const deps = (gnTarget.deps || []);
      // For dependencies that have not yet been processed, add them to the
      // queue to be processed later.
      gnTargets.push(...deps.filter(dep => {
        const gypDep = gypifyTargetName(dep);
        return !gnTargets.some(target => target === dep) &&
          !result.targets.some(target => target.target_name === gypDep);
      }));
      // Create the corresponding GYP target.
      const gypTarget: GypTarget = {
        target_name: gypifyTargetName(gnTargetName),
        type: gypifyTargetType(gnTarget.type),
        include_dirs: (gnTarget.include_dirs || [])
          .map(dir => dir.slice(2))
          .reduce(util.removeDuplicates, [] as string[]) as string[],
        defines: gnTarget.defines || [],
        sources: (gnTarget.sources || [])
          .map(dir => dir.slice(2)),
        dependencies: deps.map(gypifyTargetName)
      };
      // If it exists, attach a GYP action.
      switch (gnTarget.type) {
        case 'action': {
          gypTarget.actions = [{
            action_name: `${gypTarget.target_name}_action`,
            inputs: (gnTarget.inputs || []).map(dir => dir.slice(2)),
            outputs: (gnTarget.outputs || []).map(dir => dir.slice(2)),
            action: [
              gnTarget.script!.slice(2),
              ...(gnTarget.args || [])
            ]
          }];
          break;
        }
        case 'copy': {
          gypTarget.actions = [{
            action_name: `${gypTarget.target_name}_action`,
            inputs: (gnTarget.sources || []).map(dir => dir.slice(2)),
            outputs: (gnTarget.outputs || []).map(dir => dir.slice(2)),
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
      result.targets.push(gypTarget);
    }
    return result;
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
      .map(k => allDescs[`mac_${build}`][k])
    console.log(build, util.reportListStatistics(
      targets,
        // .filter(a => a.type === 'source_set'),
      a => a.type
    ));
  }

  // Write the gyp file
  const result = gn.createGypFile('//:libperfetto', allDescs['mac_debug']);
  await fs.writeFile(`${perfettoDir}/gypfiles/perfetto.gyp`, JSON.stringify(result, null, 2));

  await execa('./tools/gyp/gyp', [
    '-f',
    'make',
    '/Users/kelvinjin/src/node-ci/node-ci/node/deps/perfetto/gypfiles/perfetto.gyp',
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
  ]);
}

main(process.argv.slice(2)).catch(console.error);
