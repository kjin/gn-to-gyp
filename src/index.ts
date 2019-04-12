import * as execa from 'execa';
import {promises as fs} from 'fs';
import {GnProject} from './gn';
import {GypProject} from './gyp';

// specific for Perfetto
function correctPathsForScriptArgs(script: string, args: string[]): string[] {
  if (script === '//gn/standalone/build_tool_wrapper.py') {
    return args.map(arg => {
      if (arg.startsWith('../')) {
        return arg.slice(3);
      } else if (arg.startsWith('--')) {
        arg = arg.replace(
            /^(--plugin=protoc-gen-plugin=)(.*)$/,
            `$1<(SHARED_INTERMEDIATE_DIR)/$2`);
        arg = arg.replace(
            /^(--plugin_out=.*):(.*)$/, `$1:<(SHARED_INTERMEDIATE_DIR)/$2`);
        return arg;
      } else {
        return `<(SHARED_INTERMEDIATE_DIR)/${arg}`;
      }
    });
  } else {
    throw new Error('unknown script ' + script);
  }
}

async function main(args: string[]) {
  const perfettoDir = process.env.PERFETTO_PATH;
  if (!perfettoDir) {
    throw new Error(`Please define $PERFETTO_PATH`);
  }
  const gypPath = process.env.GYP_PATH;
  if (!gypPath) {
    throw new Error(`Please define $GYP_PATH`);
  }

  const serializedGnProjectPath = 'all.json';

  // Get GN build descriptions
  let gnProject: GnProject;
  let serializedGnProjectExists = true;
  try {
    await fs.stat(serializedGnProjectPath);
  } catch (e) {
    serializedGnProjectExists = false;
  }
  if (!serializedGnProjectExists) {
    gnProject = await GnProject.fromDirectory(
        perfettoDir, ['mac_debug', 'mac_release']);
    await fs.writeFile(serializedGnProjectPath, GnProject.serialize(gnProject));
  } else {
    gnProject = GnProject.deserialize(
        await fs.readFile(serializedGnProjectPath, 'utf8'));
  }

  // Write the gyp file
  const result = GypProject.fromGnProject(
      gnProject, correctPathsForScriptArgs, '//:libperfetto');
  await fs.writeFile(
      `${perfettoDir}/gypfiles/perfetto_gen.gypi`, result.toGypFile());

  // const lib = 'perfetto';
  // try {
  //   await execa(gypPath, [
  //     '-f', 'make',
  //     `/Users/kelvinjin/src/node-ci/node-ci/node/deps/${lib}/gypfiles/${
  //         lib}.gyp`,
  //     '-I', '/Users/kelvinjin/src/node-ci/node-ci/node/common.gypi', '-I',
  //     '/Users/kelvinjin/src/node-ci/node-ci/node/config.gypi', '--depth=.',
  //     '--generator-output', '/Users/kelvinjin/src/node-ci/node-ci/node/out',
  //     '-Goutput_dir=/Users/kelvinjin/src/node-ci/node-ci/node/out',
  //     '-Dcomponent=static_library', '-Dlibrary=static_library',
  //     '-Dlinux_use_bundled_binutils=0', '-Dlinux_use_bundled_gold=0',
  //     '-Dlinux_use_gold_flags=0'
  //   ]);
  // } catch (e) {
  //   console.error(e.stderr);
  // }
}

main(process.argv.slice(2)).catch(console.error);
