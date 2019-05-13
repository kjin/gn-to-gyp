import {GnProject, GnTarget, parseGnTargetName} from './gn';
import {arrayEquals, flatten, getOnlyMappedValue, removeDuplicates} from './util';

/**
 * A message to place at the top of a generated GYP file.
 */
const GEN_MSG = 'This file is automatically generated -- do not edit!';

/**
 * An object that describes a GYP build action.
 */
interface GypAction {
  action_name: string;
  inputs: string[];
  outputs: string[];
  action: string[];
}

/**
 * An object that describes common fields on a GYP target that may have
 * conditional values.
 */
interface GypFields {
  toolsets?: string[];
  include_dirs?: string[];
  dependencies?: string[];
  defines?: string[];
  sources?: string[];
  actions?: GypAction[];
  link_settings?: {libraries?: string[];};
  cflags?: string[];
  cflags_cc?: string[];
  hard_dependency?: string;
  direct_dependent_settings?: GypFields;
  all_dependent_settings?: GypFields;
}

/**
 * A GYP target.
 */
interface GypTarget extends GypFields {
  target_name: string;
  type: string;
  target_conditions?: Array<[string, GypFields]>;
}

/**
 * The minimal information needed to get a unique GN build target given a
 * GN project.
 */
interface GnTargetBuildConfig {
  name: string;
  build: string;
  toolchain: string;
}

/**
 * A helper class that is used to build GYP targets. Each GypTargetBuilder
 * corresponds uniquely to a GN target name (sans toolchain); it combines all
 * details contingent on the GN build or toolchain for that target.
 */
class GypTargetBuilder {
  private readonly targetFragments =
      new Map<string, GypTarget&{outputs?: string[]}>();

  private targetName = '';
  private targetType = '';

  /**
   * Add a GYP target "fragments" for a single GN toolchain/GYP toolset.
   * @param fragment The GYP target to add.
   * @param outputs Outputs specified by the GN target, already converted into
   * GYP-friendly paths. This is only required if the fragment type is set to
   * 'executable'.
   */
  addTargetFragment(fragment: GypTarget, outputs?: string[]) {
    // Check pre-conditions.
    if (!fragment.toolsets || fragment.toolsets.length !== 1) {
      throw new Error(`Target ${
          fragment.target_name} should have only one toolset provided.`);
    }
    const toolchain = fragment.toolsets[0];
    if (fragment.target_conditions) {
      throw new Error(`Individual toolchain config ${toolchain} for target ${
          fragment.target_name} shouldn't have its own target conditions`);
    }
    // Save the target fragment.
    this.targetFragments.set(toolchain, Object.assign({outputs}, fragment));
    // These lines implicitly verify that the target name and type match
    // previously added fragments.
    this.targetName = getOnlyMappedValue(
        Array.from(this.targetFragments.values()), x => x.target_name);
    this.targetType = getOnlyMappedValue(
        Array.from(this.targetFragments.values()), x => x.type);
  }

  /**
   * Create a single GYP target from previous added fragments by merging
   * like fields, and placing other fields under conditional blocks predicated
   * on the toolset.
   */
  buildTarget(): GypTarget {
    const builds = Array.from(this.targetFragments.keys());
    let result:
        GypTarget = {target_name: this.targetName, type: this.targetType};
    result.toolsets = builds;
    if (builds.length === 1) {
      result = Object.assign({}, this.targetFragments.get(builds[0])!, result);
      // tslint:disable-next-line:no-any
      delete (result as any).outputs;
    } else {
      const deps: string[] = [];
      {
        let depsSet = false;
        builds.forEach(build => {
          const toolchainAgnosticDeps =
              (this.targetFragments.get(build)!.dependencies ||
               []).map(dependency => {
                const sameBuildSuffix = `#${build}`;
                if (!dependency.endsWith(sameBuildSuffix)) {
                  throw new Error(`${this.targetName} for ${
                      build} toolchain has a non-${build} dependency`);
                }
                return dependency.slice(
                    0, dependency.length - sameBuildSuffix.length);
              });
          if (!depsSet) {
            deps.push(...toolchainAgnosticDeps);
          } else {
            if (!arrayEquals(deps, toolchainAgnosticDeps)) {
              throw new Error(`${
                  this.targetName} has different dependencies for different toolchains`);
            }
          }
          depsSet = true;
        });
      }
      result.target_conditions = builds.map(build => {
        const targetForBuild =
            Object.assign({}, this.targetFragments.get(build)!);
        delete targetForBuild.target_name;
        delete targetForBuild.type;
        delete targetForBuild.toolsets;
        delete targetForBuild.dependencies;
        delete targetForBuild.outputs;
        return [`_toolset=="${build}"`, targetForBuild] as [string, GypFields];
      });
      result.dependencies = deps;
    }
    return result;
  }

  /**
   * Create a GYP target that copies an executable from its default GYP path,
   * to a location expected by other targets. This is needed because GYP doesn't
   * allow setting the output path of an executable while GN does.
   */
  private buildProxyForExecutableTarget(mainTarget: GypTarget): GypTarget {
    mainTarget.target_name = `${this.targetName}_proxy`;
    const builds = Array.from(this.targetFragments.keys());
    const actionsForBuilds: GypFields[] = builds.map(build => {
      const outputs = this.targetFragments.get(build)!.outputs;
      if (!outputs || outputs.length !== 1) {
        throw new Error(
            `${this.targetName} as an executable should have just one output`);
      }
      return {
        actions: [{
          action_name: `copy_as_expected_output`,
          action: [
            'cp',
            '<@(_inputs)',
            '<@(_outputs)',
          ],
          inputs: [`<@(PRODUCT_DIR)/${this.targetName}_proxy`],
          outputs: [outputs[0]]
        }]
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
        return [
          `_toolset=="${builds[i]}"`, actionForBuild
        ] as [string, GypFields];
      });
    }
    return result;
  }

  /**
   * Create a GYP target that copies an executable from its default GYP path,
   * to a location expected by other targets. This is needed because GYP doesn't
   * allow setting the output path of an executable while GN does.
   */
  private buildProxyForStaticLibraryTarget(mainTarget: GypTarget): GypTarget {
    mainTarget.target_name = `${this.targetName}_proxy`;
    const builds = Array.from(this.targetFragments.keys());
    const result: GypTarget = {
      target_name: this.targetName,
      type: 'none',
      dependencies: [`${this.targetName}_proxy`],
      toolsets: builds
    };
    return result;
  }

  /**
   * Build at least one GYP target based on previously added target fragments.
   * It will be exactly one target unless the target is of type 'executable',
   * in which case there will be two targets:
   * - The true target itself, but suffixed with '_proxy'
   * - A facade target that depends on the true target and subsequently moves
   *   the built executable to a location expected by other build targets
   * This is to mimic the behavior of the origin GN target.
   */
  buildWithProxy(): GypTarget[] {
    if (!this.targetName || !this.targetType) {
      throw new Error('No targets were specified');
    }
    const mainTarget = this.buildTarget();
    if (this.targetType === 'executable') {
      const proxyTarget = this.buildProxyForExecutableTarget(mainTarget);
      return [mainTarget, proxyTarget];
    } else if (this.targetType === 'static_library') {
      mainTarget.target_name = `${this.targetName}_proxy`;
      const proxyTarget = this.buildProxyForStaticLibraryTarget(mainTarget);
      return [mainTarget, proxyTarget];
      // mainTarget.hard_dependency = 'True';
      // return [mainTarget];
    } else {
      return [mainTarget];
    }
  }
}

/**
 * Given a GN target name, create a reasonable GYP target name.
 * TODO(kjin): There isn't necessarily a 1:1 guarantee.
 * @param gnTargetName The GN target name to convert.
 */
function gypifyTargetName(gnTargetName: string): string {
  if (gnTargetName.indexOf('(') !== -1) {
    gnTargetName = gnTargetName.slice(0, gnTargetName.indexOf('('));
  }
  gnTargetName = gnTargetName.slice(2);
  gnTargetName = gnTargetName.replace(':', '_');
  while (gnTargetName.indexOf('/') !== -1) {
    gnTargetName = gnTargetName.replace('/', '_');
  }
  while (gnTargetName.indexOf('+') !== -1) {
    gnTargetName = gnTargetName.replace('+', '_');
  }
  return gnTargetName;
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
 * Given a GN path (and build name -- to translate generated file paths), return
 * a GYP path.
 * This function can be applied to include_dirs, inputs, outputs, sources, etc.
 * @param gnBuildName The GN build name.
 * @param gnPath The GN path.
 */
function gypifyPath(gnBuildName: string, gnPath: string): string {
  const outPrefix = `//out/${gnBuildName}/`;
  if (gnPath.startsWith(outPrefix)) {
    return `<(SHARED_INTERMEDIATE_DIR)/${gnPath.slice(outPrefix.length)}`;
  } else if (gnPath.startsWith('//')) {
    return `<(root_relative_to_gypfile)/${gnPath.slice(2)}`;
  }
  throw new Error(`Unexpected path: ${gnPath}`);
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
      result.push(cflags[i + 1]);
    }
  }
  return result;
}

/**
 * A function that describes how path arguments to scripts should be corrected.
 * It's script-dependent, and scripts are project-dependent, so this should
 * vary per-project.
 */
export type CorrectPathsForScriptArgs = (script: string, args: string[]) =>
    string[];
/**
 * A function that describes how include paths in cflags should be corrected.
 * This is project-dependent.
 */
export type CorrectPathForCFlagInclude = (include: string) => string;
export type GypProjectOptions = {
  /**
   * A function describing how path arguments to scripts should be corrected.
   */
  correctPathsForScriptArgs: CorrectPathsForScriptArgs;
  /**
   * A function that describes how include paths in cflags should be corrected.
   */
  correctPathForCFlagInclude: CorrectPathForCFlagInclude;
  /**
   * The root target that will be processed. This info is important because for
   * the root target, also specify public configuration. Child targets don't
   * need this because their public configurations are already reflected in
   * their parents as a result of `gn desc`.
   */
  gnRootTargetName: string;
  subprojects: GypProjectSplitOptions[];
};

export type GypProjectSplitOptions = {
  name: string,
  file: string;
  predicate: (gnTargetName: string) => boolean;
  setNewPath: (path: string) => string;
  // rootRelativeToGypFile: string;
}

/**
 * A helper class that can build a GYP project from a GN project.
 */
class GypProjectBuilder {
  private static readonly ignoreTargets = (targetName: string) => {
    return targetName.startsWith('//gn') && !targetName.startsWith('//gn:protoc');
  };
  private static readonly toolchainMap: {[k: string]: string} = {
    '//gn/standalone/toolchain:gcc_like_host': 'host',
    '//gn/standalone/toolchain:gcc_like': 'target'
  };

  /**
   * Construct a new GypProjectBuilder instance.
   */
  constructor(
    private readonly gnProject: GnProject,
    private readonly options: GypProjectOptions) {}

  /**
   * Given a GN toolchain, return a suitable GYP toolset, or throw if there
   * isn't one.
   * @param gnToolchain The GN toolchain.
   */
  toGypToolset(gnToolchain: string): string {
    if (!gnToolchain) {
      throw new Error(`Can't resolve toolchain with no information`);
    }
    if (!GypProjectBuilder.toolchainMap[gnToolchain]) {
      throw new Error(`Unrecognized GN toolchain: ${gnToolchain}`);
    }
    return GypProjectBuilder.toolchainMap[gnToolchain];
  }

  private getGenDirectoryForToolset(
      {toolchain, build}: {toolchain: string, build: string}): string {
    let outputDir = '<(SHARED_INTERMEDIATE_DIR)';
    if (toolchain !== this.gnProject.getBuild(build).getDefaultToolchain()) {
      outputDir += `/${parseGnTargetName(toolchain).target}`;
    }
    return outputDir;
  }

  private getSubproject(name: string) {
    const matchingSubprojects = this.options.subprojects.filter(subProject => subProject.predicate(name));
    if (matchingSubprojects.length !== 1) {
      throw new Error(`Expected ${name} to belong to one subproject but it belongs to multiple.`);
    }
    return matchingSubprojects[0];
  }

  private applySubprojectPathTransforms(path: string): string {
    for (const subproject of this.options.subprojects) {
      path = subproject.setNewPath(path);
    }
    return path;
  }

  /**
   * Given a GN target and additional information about it not contained within
   * the target, create a GYP target "fragment".
   * @param gnTarget The GN target.
   * @param gnTargetBuildConfig Additional information about the GN target.
   */
  private toGypTargetFragment(
      subprojectName: string, gnTarget: GnTarget, gnTargetBuildConfig: GnTargetBuildConfig): GypTarget {
    const boundGypifyPath = (path: string) =>
        this.applySubprojectPathTransforms(gypifyPath(gnTargetBuildConfig.build, path));
    const boundParseGnTargetName = (dep: string) => {
      const parsedGnTargetName = parseGnTargetName(dep);
      if (!parsedGnTargetName.toolchain) {
        parsedGnTargetName.toolchain = this.gnProject.getBuild(gnTargetBuildConfig.build)
                        .getDefaultToolchain();
      }
      return parsedGnTargetName;
    };

    // Create the corresponding GYP target.
    const targetName = gypifyTargetName(gnTargetBuildConfig.name);
    if (!gnTarget.type) {
      throw new Error(`GN target ${targetName} has no type.`);
    }
    const targetToolset = this.toGypToolset(gnTargetBuildConfig.toolchain);
    let targetType = gypifyTargetType(gnTarget.type);

    const fragment: GypTarget = {
      target_name: targetName,
      type: targetType,
      // Static libraries cannot depend on each other in GYP unless this flag
      // is set to true.
      // hard_dependency: 'True',
      toolsets: [targetToolset]
    };

    {  // Root target custom override.
      if (gnTargetBuildConfig.name === this.options.gnRootTargetName) {
        if (targetType !== 'shared_library' && targetType !== 'static_library') {
          // Not sure what to do yet when the specified root target is not
          // a shared or static library.
          throw new Error('Root target must be a shared or static library.');
        }
        fragment.type = '<(library)';
        targetType = 'static_library';
      }
    }

    {  // Dependencies
      fragment.dependencies = gnTarget.deps
        .filter(name => !GypProjectBuilder.ignoreTargets(name))
        .map(gnDep => {
          const {path, target, toolchain} = boundParseGnTargetName(gnDep);
          // Get which GYP subproject this belongs to.
          const subproject = this.getSubproject(`//${path}:${target}`);
          let prefix = '';
          if (subproject.name !== subprojectName) {
            prefix = `${subproject.file}:`;
          }
          return `${prefix}${gypifyTargetName(`//${path}:${target}`)}#${
              this.toGypToolset(toolchain)}`;
        });
    }

    {  // Include Directories
      const includeDirs: string[] = [
        ...(gnTarget.include_dirs || []).map(boundGypifyPath),
        ...extractIncludes(gnTarget.cflags || [])
          .map(this.options.correctPathForCFlagInclude)
          .map((path) => {
            if (path.startsWith('../')) {
              return `<(root_relative_to_gypfile)/${path.slice('../'.length)}`;
            } else {
              return path;
            }
          })
          .map(path => this.applySubprojectPathTransforms(path))
      ].reduce(removeDuplicates, [] as string[]);
      fragment.include_dirs = includeDirs;
    }

    {  // Defines
      fragment.defines = gnTarget.defines || [];
    }

    {  // Sources
      fragment.sources = (gnTarget.sources || [])
        .map(boundGypifyPath);
      if (targetType === 'static_library') {
        // empty.cc is here to satisfy the linker if there are no cc files.
        // TODO: Make this more robust.
        if (!fragment.sources!.some(source => source.endsWith('.cc'))) {
          fragment.sources!.push(`${
              this.getGenDirectoryForToolset(gnTargetBuildConfig)}/gen/empty.cc`);
          fragment.dependencies!.push(`./empty.gyp:gen_empty_cc#${targetToolset}`);
        }
      }
    }

    {  // Action
      switch (gnTarget.type) {
        case 'action': {
          if (!gnTarget.script) {
            throw new Error(
                `${gnTargetBuildConfig.name} is an action but has no script`);
          }
          const metaInputs =
              [...(gnTarget.inputs || []), ...(gnTarget.sources || [])];
          fragment.actions = [{
            action_name: `${targetName}_action`,
            inputs: metaInputs.map(boundGypifyPath),
            outputs: (gnTarget.outputs || []).map(boundGypifyPath),
            action: [
              ...(gnTarget.script.endsWith('.py') ? ['python'] : []),
              boundGypifyPath(gnTarget.script!),
              ...this.options.correctPathsForScriptArgs(
                  gnTarget.script, gnTarget.args || [])
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
            inputs: (gnTarget.sources || []).map(boundGypifyPath),
            outputs: (gnTarget.outputs || []).map(boundGypifyPath),
            action: ['cp', '<@(_inputs)', '<@(_outputs)']
          }];
          break;
        }
        default:
          break;
      }
    }

    // Apparently libs not allowed in DEBUG.
    // if (gnTarget.libs) {
    //   gypFields.link_settings = {
    //     libraries: gnTarget.libs.map(l => `-l${l}`)
    //   };
    // }

    return fragment;
  }

  /**
   * Given a list of toolchain and build name combinations for a single GN
   * target, return a list of GYP targets that correspond to the GN target.
   * @param gnTargetBuildConfigs Information about the GN target and desired
   * toolchain and build name combinations. The "name" field should be the same
   * across all values.
   */
  toGypTargets(splitName: string, gnTargetBuildConfigs: GnTargetBuildConfig[]): GypTarget[] {
    if (gnTargetBuildConfigs.length === 0) {
      throw new Error('Input is length 0');
    }
    const name = gnTargetBuildConfigs[0].name;
    if (gnTargetBuildConfigs.some(e => e.name !== name)) {
      throw new Error('Name isn\'t the same across all elements');
    }
    if (GypProjectBuilder.ignoreTargets(name)) {
      return [];
    }
    const targetBuilder = new GypTargetBuilder();
    // TODO(kjin): Right now we filter non-mac_debug builds.
    gnTargetBuildConfigs
        .filter(
            gnTargetBuildConfig => gnTargetBuildConfig.build === 'mac_debug')
        .forEach(gnTargetBuildConfig => {
          const gnTarget =
              this.gnProject.getBuild(gnTargetBuildConfig.build)
                  .getTarget(
                      gnTargetBuildConfig.toolchain, gnTargetBuildConfig.name);
          const fragment =
              this.toGypTargetFragment(splitName, gnTarget, gnTargetBuildConfig);
          const outputs =
              (gnTarget.outputs ||
               []).map(output => gypifyPath(gnTargetBuildConfig.build, output));
          targetBuilder.addTargetFragment(fragment, outputs);
        });
    return targetBuilder.buildWithProxy();
  }

  /**
   * Create a target that generates an empty.cc file. This file is used as a
   * dummy file to satisfy the linker when no other *.cc files are present in
   * a static_library target.
   */
  generateEmptyCCTarget(): GypTarget {
    const emptyCCTarget = new GypTargetBuilder();
    for (const build of this.gnProject.getBuildNames()) {
      // TODO(kjin): Right now we filter non-mac_debug builds.
      if (build !== 'mac_debug') continue;
      for (const toolchain of this.gnProject.getBuild(build).getToolchains()) {
        const output = `${
            this.getGenDirectoryForToolset({build, toolchain})}/gen/empty.cc`;
        emptyCCTarget.addTargetFragment({
          target_name: 'gen_empty_cc',
          type: 'none',
          actions: [{
            action_name: 'gen_empty_cc_action',
            inputs: [],
            outputs: [output],
            action: ['touch', '-a', output]
          }],
          toolsets: [this.toGypToolset(toolchain)]
        });
      }
    }
    return emptyCCTarget.buildTarget();
  }
}

/**
 * A class representing a GYP project.
 */
export class GypProject {
  private data: Array<{
    name: string;
    file: string;
    targets: GypTarget[];
  }> = [];

  /**
   * Create a GYP build file from this instance.
   */
  toGypFile(name: string): string {
    const subproject = this.data.find(s => s.name === name);
    if (!subproject) {
      throw new Error(`Subproject ${name} doesn't exist.`);
    }
    return `# ${GEN_MSG}\n${JSON.stringify({
      variables: { root_relative_to_gypfile: '..' },
      targets: subproject.targets
    }, null, 2)}`;
  }

  /**
   * Given a root target name, return all of the target-build-toolchain tuples
   * needed to build it.
   * @param gnProject A GN project.
   * @param gnRootTarget A GN target name.
   */
  private static getAllGnTargetDeps(gnProject: GnProject, gnRootTarget: string):
      GnTargetBuildConfig[] {
    const seenGnBuildConfigs = new Set<string>();
    const gnBuildConfigQueue: GnTargetBuildConfig[] =
        gnProject.getBuildNames().map(gnBuildName => {
          const build = gnProject.getBuild(gnBuildName);
          const toolchain = build.getDefaultToolchain();
          return {name: gnRootTarget, build: gnBuildName, toolchain};
        });
    while (gnBuildConfigQueue.length > 0) {
      const gnBuildConfig = gnBuildConfigQueue.shift()!;
      seenGnBuildConfigs.add(JSON.stringify(gnBuildConfig));
      const gnTarget =
          gnProject.getBuild(gnBuildConfig.build)
              .getTarget(gnBuildConfig.toolchain, gnBuildConfig.name);
      const deps =
          gnTarget.deps
              .map(dep => {
                const {path: file, target, toolchain} = parseGnTargetName(dep);
                return {
                  name: `//${file}:${target}`,
                  build: gnBuildConfig.build,
                  toolchain: toolchain || gnBuildConfig.toolchain
                };
              })
              .filter(dep => !seenGnBuildConfigs.has(JSON.stringify(dep)));
      gnBuildConfigQueue.push(...deps);
    }
    return Array.from(seenGnBuildConfigs.values())
        .map(gnBuildConfig => JSON.parse(gnBuildConfig));
  }

  /**
   * Given a GN project, a function that corrects paths for script action
   * arguments, and a GN target name, return a GYP project that contains all of
   * the targets needed to build that GN target as a GYP target.
   * @param gnProject A GN project.
   * @param correctPathsForScriptArgs A function describing how path arguments
   * to scripts should be corrected.
   * @param gnRootTarget A GN target name.
   */
  static fromGnProject(
      gnProject: GnProject,
      options: GypProjectOptions): GypProject {
    const result = new GypProject();
    // Get the exact list of dependencies needed.
    const gnTargetDeps = GypProject.getAllGnTargetDeps(gnProject, options.gnRootTargetName);
    const gnTargetDepNames: string[] =
        gnTargetDeps.map(dep => dep.name)
            .reduce(removeDuplicates, [] as string[]);
    const projectBuilder = new GypProjectBuilder(gnProject, options);
    for (const subproject of options.subprojects) {
      const filteredGnTargetDepNames = gnTargetDepNames.filter(subproject.predicate);
      const targets = [];
      for (const gnTargetDepName of filteredGnTargetDepNames) {
        const gypTargets = projectBuilder.toGypTargets(subproject.name, gnTargetDeps.filter(
            gnTargetDep => gnTargetDep.name === gnTargetDepName));
        targets.push(...gypTargets)
      }
      result.data.push({
        name: subproject.name,
        file: subproject.file,
        targets: [...targets]
      });
    }
    result.data.push({
      name: 'empty',
      file: 'empty.gyp',
      targets: [projectBuilder.generateEmptyCCTarget()]
    });
    return result;
  }
}
