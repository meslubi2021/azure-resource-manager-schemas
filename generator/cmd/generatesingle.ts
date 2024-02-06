// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import * as constants from '../constants';
import { cloneAndGenerateBasePaths, resolveAbsolutePath, validateAndReturnReadmePath } from '../specs';
import { generateSchemas, saveAutoGeneratedSchemaRefs } from '../generate';
import { findOrGenerateAutogenEntries } from '../autogenlist';
import colors from 'colors';
import { executeSynchronous } from '../utils';
import yargs from 'yargs';

const argsConfig = yargs
  .strict()
  .option('base-path', { type: 'string', demandOption: true, desc: 'The swagger base path in the specs repo (e.g. "compute/resource-manager")' })
  .option('local-path', { type: 'string', desc: 'The local path to the azure-rest-api-specs repo' });

executeSynchronous(async () => {
    const args = await argsConfig.parseAsync();

    const basePath = args['base-path'];
    let localPath = args['local-path'];
    if (!localPath) {
        localPath = constants.specsRepoPath;
        await cloneAndGenerateBasePaths(localPath, constants.specsRepoUri, constants.specsRepoCommitHash);
    } else {
        localPath = await resolveAbsolutePath(localPath);
    }

    let readme = '';
    try {
        readme = validateAndReturnReadmePath(localPath, basePath);
    } catch {
        throw new Error(`Unable to find a readme under '${localPath}' for base path '${basePath}'. Please try running 'npm run list-basepaths' to find the list of valid paths.`);
    }

    const schemaConfigs = [];
    const autoGenEntries = await findOrGenerateAutogenEntries(basePath, readme);

    for (const autoGenConfig of autoGenEntries) {
        if (autoGenConfig.disabledForAutogen === true) {
            console.log(`Path ${autoGenConfig.basePath} has been disabled for generation:`)
            console.log(colors.red(JSON.stringify(autoGenConfig, null, 2)));
            continue;
        }

        console.log(`Using autogenlist config:`)
        console.log(colors.green(JSON.stringify(autoGenConfig, null, 2)));

        const localSchemaConfigs = await generateSchemas(readme, autoGenConfig);
        schemaConfigs.push(...localSchemaConfigs);
    }

    await saveAutoGeneratedSchemaRefs(schemaConfigs);
});