// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import * as constants from '../constants';
import { cloneAndGenerateBasePaths, generateBasePaths, getPackageString, resolveAbsolutePath, validateAndReturnReadmePath } from '../specs';
import { SchemaConfiguration, generateSchemas, clearAutoGeneratedSchemaRefs, saveAutoGeneratedSchemaRefs, getApiVersionsByNamespace } from '../generate';
import { findOrGenerateAutogenEntries } from '../autogenlist';
import chalk from 'chalk';
import { flatten, keys } from 'lodash';
import { executeSynchronous, chunker, writeJsonFile } from '../utils';
import { Package } from '../models';
import yargs from 'yargs';
import path from 'path';

import { createWriteStream } from 'fs';
import stripAnsi from 'strip-ansi';

const argsConfig = yargs
  .strict()
  .option('batch-count', { type: 'number', desc: 'If running in batch mode, the total number of batch jobs running' })
  .option('batch-index', { type: 'number', desc: 'If running in batch mode, the index of this batch job' })
  .option('local-path', { type: 'string', desc: 'The local path to the azure-rest-api-specs repo' })
  .option('readme-files', { type: 'array', desc: 'The list of readme.md files to generate schemas for' })
  .option('output-path', { type: 'string', desc: 'The base path to save schema output' })
  .option('summary-log-path', { type: 'string', desc: 'The path to store generation summary information. File will be saved in md format.' });

interface ILogger {
    out: (data: string) => void;
}

executeSynchronous(async () => {
    const args = await argsConfig.parseAsync();

    let basePaths;
    let localPath = args['local-path'];
    let summaryPath = args['summary-log-path'];

    // localPath refers to the specs repo (azure-rest-api-specs)
    if (!localPath) {
        localPath = constants.specsRepoPath;
        basePaths = await cloneAndGenerateBasePaths(localPath, constants.specsRepoUri, constants.specsRepoCommitHash);
    } else {
        localPath = await resolveAbsolutePath(localPath);
        basePaths = await generateBasePaths(localPath);
    }

    if (!summaryPath) {
        // using 'localPath' here because at this point it is guaranteed that the folder got created (when cloneAndGenerateBasePaths function is invoked)
        // or is an existing path
        summaryPath = path.join(localPath, 'summary.log');
        console.log(`Summary path not passed, using default value: ${summaryPath}`);
    }

    // resolve absolute path
    summaryPath = await resolveAbsolutePath(summaryPath);

    if (args['batch-count'] !== undefined && args['batch-index'] !== undefined) {
        basePaths = chunker(basePaths, args['batch-count'])[args['batch-index']];
    }

    const schemaConfigs: SchemaConfiguration[] = [];
    const packages: Package[] = [];

    const summaryLogger = await getLogger(summaryPath);

    for (const basePath of basePaths) {
        try {
            const readme = validateAndReturnReadmePath(localPath, basePath);
            const namespaces = keys(await getApiVersionsByNamespace(readme));
            let filteredAutoGenList = findOrGenerateAutogenEntries(basePath, namespaces)
                .filter(x => x.disabledForAutogen !== true);

            if (args['readme-files']) {
                filteredAutoGenList = filteredAutoGenList.filter(c => {
                    const readmeFiles = args['readme-files']?.map(x => x.toString());
                    const r = readmeFiles?.find(f => f.startsWith('specification/' + c.basePath));
                    if (r) {
                        c.readmeFile = r;
                        return true;
                    }
                    return false;
                });
            }

            await clearAutoGeneratedSchemaRefs(filteredAutoGenList);

            for (const autoGenConfig of filteredAutoGenList) {
                const pkg = {
                    path: ['schemas']
                } as Package;
                try {
                    const readme = validateAndReturnReadmePath(localPath, autoGenConfig.readmeFile || autoGenConfig.basePath);
                    pkg.packageName = getPackageString(readme);

                    const startTime = Date.now();
                    const newConfigs = await generateSchemas(readme, autoGenConfig);
                    const generationTime = Date.now() - startTime;
                    console.log(`Time taken to generate ${chalk.green.italic(autoGenConfig.basePath)} : ${chalk.magenta.bold(generationTime)} ms.`);
                    schemaConfigs.push(...newConfigs);
                    pkg.result = 'succeeded';
                    logOut(summaryLogger, 
                        `<details>
                        <summary>Successfully generated types for base path '${basePath}'.</summary>
                        </details>
                        `);
                } catch(error) {
                    pkg.packageName = autoGenConfig.basePath;
                    pkg.result = 'failed';
                    console.log(chalk.red(`Caught exception processing autogenlist entry ${autoGenConfig.basePath}.`));
                    console.log(chalk.red(error));
            
                    // Use markdown formatting as this summary will be included in the PR description
                    logOut(summaryLogger, 
                        `<details>
                        <summary>Failed to generate types for base path '${autoGenConfig.basePath}' and namespace '${autoGenConfig.namespace}'</summary>
                        \`\`\`
                        ${error}
                        \`\`\`
                        </details>
                        `);
                }
                packages.push(pkg);
            }
        } catch (error) {
            // Use markdown formatting as this summary will be included in the PR description
            // This error usually indicates that a file has not been found (readme)
            logOut(summaryLogger, 
                `<details>
                <summary>Failed to generate types for base path '${basePath}' probably due to readme not found or due to any other file not found exception.</summary>
                \`\`\`
                ${error}
                \`\`\`
                </details>
                `);
        }
        
    }

    await saveAutoGeneratedSchemaRefs(flatten(schemaConfigs));

    if (args['output-path']) {
        const outputPath = await resolveAbsolutePath(args['output-path']);
        await writeJsonFile(outputPath, { packages });
    }
});

function logOut(logger: ILogger, line: string) {
    logger.out(`${line}\n`);
}
  
async function getLogger(logFilePath: string): Promise<ILogger> {
    const logFileStream = createWriteStream(logFilePath, { flags: 'a' });

    return {
        out: (data: string) => {
            process.stdout.write(data);
            logFileStream.write(stripAnsi(data));
        }
    };
}
