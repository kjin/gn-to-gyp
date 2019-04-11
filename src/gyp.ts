import { GnProject, parseGnTargetName, GnTarget } from "./gn";
import { removeDuplicates, arrayEquals, getOnlyMappedValue } from "./util";

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

interface GnTargetBuildConfig {
  name: string;
  build: string;
  toolchain: string;
}

// TODO: Clean up this class.
class GypTargetBuilder {
  private readonly targetFragments = new Map<string, GypTarget & { outputs?: string[] }>();

  private targetName: string = '';
  private targetType: string = '';

  setTargetForToolset(toolchain: string, fragment: GypTarget, outputs?: string[]) {
    if (fragment.target_conditions) {
      throw new Error(`Individual toolchain config shouldn't have its own target conditions: ${toolchain}, ${fragment.target_conditions}`);
    }
    this.targetFragments.set(toolchain, Object.assign({ outputs }, fragment));
    this.targetName = getOnlyMappedValue(Array.from(this.targetFragments.values()), x => x.target_name);
    this.targetType = getOnlyMappedValue(Array.from(this.targetFragments.values()), x => x.type);
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
            if (!arrayEquals(deps, toolchainAgnosticDeps)) {
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
    if (!this.targetName || !this.targetType) {
      throw new Error('No targets were specified');
    }
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

function canonicalizePath(build: string, p: string): string {
  const outPrefix = `//out/${build}/`;
  if (p.startsWith(outPrefix)) {
    return `<(SHARED_INTERMEDIATE_DIR)/${p.slice(outPrefix.length)}`;
  } else if (p.startsWith('//')) {
    return `../${p.slice(2)}`;
  }
  throw new Error(`Unexpected path: ${p}`);
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

/**
 * Given a GN target name, create a reasonable GYP target name.
 * @param target 
 */
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

export type CorrectPathsForScriptArgs = (script: string, args: string[]) => string[];

class GypProjectBuilder {
  private readonly toolchainMap: { [k: string]: string } = {
    '//gn/standalone/toolchain:gcc_like_host': 'host',
    '//gn/standalone/toolchain:gcc_like': 'target'
  };

  constructor(
    private readonly gnProject: GnProject,
    private readonly correctPathsForScriptArgs: CorrectPathsForScriptArgs
  ) {}

  private toGypToolset(gnBuild: string, gnToolchain: string): string {
    if (!gnToolchain) {
      gnToolchain = this.gnProject.getBuild(gnBuild).getDefaultToolchain();
    }
    if (!this.toolchainMap[gnToolchain]) {
      throw new Error();
    }
    return this.toolchainMap[gnToolchain];
  }

  toGypTargetFragment(gnTarget: GnTarget, gnTargetBuildConfig: GnTargetBuildConfig): GypTarget {
    const boundCanonicalizePath = (path: string) => canonicalizePath(gnTargetBuildConfig.build, path);
    const deps = (gnTarget.deps || []);
      // Create the list of include dirs.
    const includeDirs: string[] = [
      ...(gnTarget.include_dirs || []).map(boundCanonicalizePath),
      ...extractIncludes(gnTarget.cflags || [])
    ].reduce(removeDuplicates, [] as string[]);
    // Create the corresponding GYP target.
    const targetName = gypifyTargetName(gnTargetBuildConfig.name);
    const targetType = gypifyTargetType(gnTarget.type);
    const targetToolchain = this.toGypToolset(gnTargetBuildConfig.build, gnTargetBuildConfig.toolchain);
    const fragment: GypTarget = {
      target_name: targetName,
      type: targetType,
      include_dirs: includeDirs,
      defines: gnTarget.defines || [],
      // empty.cc is here to satisfy the linker if there are no cc files.
      // TODO Make this more robust.
      sources: (gnTarget.sources || []).map(boundCanonicalizePath),
      dependencies: deps.map(dep => {
        const { path: file, target, toolchain } = parseGnTargetName(dep);
        return `${gypifyTargetName(`//${file}:${target}`)}#${this.toGypToolset(gnTargetBuildConfig.build, toolchain)}`
      }),
      cflags: gnTarget.cflags || [],
      cflags_cc: gnTarget.cflags_cc || [],
      // Static libraries cannot depend on each other in GYP unless this flag
      // is set to true.
      hard_dependency: 'True',
    };
    if (targetType === 'static_library') {
      fragment.sources!.push('<(SHARED_INTERMEDIATE_DIR)/empty.cc');
      fragment.dependencies!.push(`gen_empty_cc#${targetToolchain}`);
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
          throw new Error(`${gnTargetBuildConfig.name} is an action but has no script`);
        }
        const metaInputs = [
          ...(gnTarget.inputs || []),
          ...(gnTarget.sources || [])
        ];
        fragment.actions = [{
          action_name: `${targetName}_action`,
          inputs: metaInputs.map(boundCanonicalizePath),
          outputs: (gnTarget.outputs || []).map(boundCanonicalizePath),
          action: [
            ...(gnTarget.script.endsWith('.py') ? ['python'] : []),
            boundCanonicalizePath(gnTarget.script!),
            ...this.correctPathsForScriptArgs(gnTarget.script, gnTarget.args || [])
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
        fragment.actions = [{
          action_name: `${targetName}_action`,
          inputs: (gnTarget.sources || []).map(boundCanonicalizePath),
          outputs: (gnTarget.outputs || []).map(boundCanonicalizePath),
          action: [
            'cp',
            '<@(_inputs)',
            '<@(_outputs)'
          ]
        }];
        break;
      }
    }
    return fragment;
  }
  
  toGypTargets(
    gnTargetBuildConfigs: GnTargetBuildConfig[]
  ): GypTarget[] {
    const targetBuilder = new GypTargetBuilder();
    gnTargetBuildConfigs
      .filter(gnTargetBuildConfig => gnTargetBuildConfig.build === 'mac_debug')
      .forEach(gnTargetBuildConfig => {
        const gnTarget = this.gnProject.getBuild(gnTargetBuildConfig.build)
          .getTarget(gnTargetBuildConfig.toolchain, gnTargetBuildConfig.name);
        const fragment = this.toGypTargetFragment(gnTarget, gnTargetBuildConfig);
        const outputs = (gnTarget.outputs || []).map(output => canonicalizePath(gnTargetBuildConfig.build, output));
        targetBuilder.setTargetForToolset(
          this.toGypToolset(gnTargetBuildConfig.build, gnTargetBuildConfig.toolchain), fragment, outputs);
      });
    return targetBuilder.buildWithProxy();
  }
}

export class GypProject {
  private targets: GypTarget[] = [];

  toGypFile(): string {
    return JSON.stringify({ targets: this.targets }, null, 2);
  }

  private static getAllGnTargetDeps(gnProject: GnProject, gnRootTarget: string): GnTargetBuildConfig[] {
    const seenGnBuildConfigs = new Set<string>();
    const gnBuildConfigQueue: GnTargetBuildConfig[] = gnProject.getBuildNames().map(gnBuildName => {
      const build = gnProject.getBuild(gnBuildName);
      const toolchain = build.getDefaultToolchain();
      return { name: gnRootTarget, build: gnBuildName, toolchain };
    });
    while (gnBuildConfigQueue.length > 0) {
      const gnBuildConfig = gnBuildConfigQueue.shift()!;
      seenGnBuildConfigs.add(JSON.stringify(gnBuildConfig));
      const gnTarget = gnProject
        .getBuild(gnBuildConfig.build)
        .getTarget(gnBuildConfig.toolchain, gnBuildConfig.name);
      const deps = gnTarget.deps.map(dep => {
        const { path: file, target, toolchain } = parseGnTargetName(dep);
        return {
          name: `//${file}:${target}`,
          build: gnBuildConfig.build,
          toolchain: toolchain || gnBuildConfig.toolchain
        };
      }).filter(dep => !seenGnBuildConfigs.has(JSON.stringify(dep)));
      gnBuildConfigQueue.push(...deps);
    }
    return Array.from(seenGnBuildConfigs.values())
      .map(gnBuildConfig => JSON.parse(gnBuildConfig));
  }

  static fromGnProject(gnProject: GnProject, correctPathsForScriptArgs: CorrectPathsForScriptArgs, gnRootTarget: string): GypProject {
    const result = new GypProject();
    // Get the exact list of dependencies needed.
    const gnTargetDeps = GypProject.getAllGnTargetDeps(gnProject, gnRootTarget);
    const gnTargetDepNames: string[] = gnTargetDeps.map(dep => dep.name)
      .reduce(removeDuplicates, [] as string[]);
    const projectBuilder = new GypProjectBuilder(gnProject, correctPathsForScriptArgs);
    for (const gnTargetDepName of gnTargetDepNames) {
      const gypTargets = projectBuilder.toGypTargets(
        gnTargetDeps.filter(gnTargetDep => gnTargetDep.name === gnTargetDepName)
      );
      result.targets.push(...gypTargets);
    }
    // Create a dummy empty.cc file action.
    const emptyCCTarget = new GypTargetBuilder();
    for (const toolchain of ['host', 'target']) {
      emptyCCTarget.setTargetForToolset(toolchain, {
        target_name: 'gen_empty_cc',
        type: 'none',
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
    result.targets.push(...emptyCCTarget.buildWithProxy());
    return result;
  }
}
