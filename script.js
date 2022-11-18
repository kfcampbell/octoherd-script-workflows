// @ts-check

import * as fs from 'fs';
import path from 'path';

async function shouldCreateCodeqlPR(octokit, repository) {
	// check to see if .github/workflows/codeql.yml exists
	let codeqlYmlExists = false;
	try {
		const codeqlYml = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: repository.owner.login,
			repo: repository.name,
			path: '.github/workflows/codeql.yml',
		});
		codeqlYmlExists = true;
	} catch (err) {
		// if the error is a 404, then the file does not exist
		if (err.status !== 404) {
			throw err;
		}
		codeqlYmlExists = false;
	}

	let codeqlYamlExists = false;
	if (!codeqlYmlExists) {
		try {
			const codeqlYaml = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
				owner: repository.owner.login,
				repo: repository.name,
				path: '.github/workflows/codeql.yaml',
			});
			codeqlYamlExists = true;
		} catch (err) {
			// if the error is a 404, then the file does not exist
			if (err.status !== 404) {
				throw err;
			}
			codeqlYamlExists = false;
		}
	}

	if (codeqlYmlExists || codeqlYamlExists) {
		return false
	}
	return true
}

async function shouldCreateDependabotPR(octokit, repository) {

	// check to see if .github/dependabot.yml exists
	let dependabotYmlExists = false;
	try {
		const { data: dependabotYml } = await octokit.request(
			'GET /repos/{owner}/{repo}/contents/{path}',
			{
				owner: repository.owner.login,
				repo: repository.name,
				path: '.github/dependabot.yml',
			}
		);
		if (dependabotYml) {
			dependabotYmlExists = true;
		}
	} catch (err) {
		// ignore if it's a 404 error
		if (err.status !== 404) {
			throw err;
		}
	}

	let dependabotYamlExists = false;
	// if .github/dependabot.yml doesn't exist, try .github/dependabot.yaml
	if (!dependabotYmlExists) {
		try {
			const { data: dependabotYaml } = await octokit.request(
				'GET /repos/{owner}/{repo}/contents/{path}',
				{
					owner: repository.owner.login,
					repo: repository.name,
					path: '.github/dependabot.yaml',
				}
			);
			if (dependabotYaml) {
				dependabotYamlExists = true;
			}
		} catch (err) {
			// ignore if it's a 404 error
			if (err.status !== 404) {
				throw err;
			}
		}


		// if neither .github/dependabot.yml or .github/dependabot.yaml exist, create a PR to add .github/dependabot.yml
		// first check to see if .github/renovate.json exists. if it does, we don't want to add .github/dependabot.yml

		if (!dependabotYmlExists && !dependabotYamlExists) {

			// check to see if renovate.json exists in the repo
			let renovateJsonExists = false;
			try {
				const { data: renovateJson } = await octokit.request(
					'GET /repos/{owner}/{repo}/contents/{path}',
					{
						owner: repository.owner.login,
						repo: repository.name,
						path: '.github/renovate.json',
					}
				);
				if (renovateJson) {
					renovateJsonExists = true;
				}
			} catch (err) {
				// ignore if it's a 404 error
				if (err.status !== 404) {
					throw err;
				}
			}

			// if no renovate.json, dependabot.yml, or dependabot.yaml exists,
			// we need to create a new dependabot PR
			if (!renovateJsonExists) {
				return true
			}
		}
	}
	return false
}

async function openPR(octokit, repository, branchRef, title, body) {
	await octokit.request('POST /repos/{owner}/{repo}/pulls', {
		owner: repository.owner.login,
		repo: repository.name,
		title: title,
		body: body,
		head: branchRef,
		base: repository.default_branch,
	});
}

async function createBranch(octokit, repository, branchName) {
	// get SHA of latest default branch commit
	const { data: { object: { sha } } } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
		owner: repository.owner.login,
		repo: repository.name,
		ref: `heads/${repository.default_branch}`,
	});

	// create a branch off of the latest repo SHA
	const branch = await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
		owner: repository.owner.login,
		repo: repository.name,
		ref: `refs/heads/${branchName}`,
		sha: sha,
	});
	return branch
}

/**
 * Creates PRs to add CodeQL and Dependabot workflows across repositories
 *
 * @param {import('@octoherd/cli').Octokit} octokit
 * @param {import('@octoherd/cli').Repository} repository
 */
export async function script(octokit, repository, { templateDirectory }) {

	// get list of all files in templates directory
	const files = fs.readdirSync(templateDirectory);

	// iterate through files and store the string content of each file
	const templates = await Promise.all(
		files.map(async (file) => {
			// read the string content of each file in the templates directory into variable
			const template = await fs.promises.readFile(
				path.join(templateDirectory, file),
				'utf8'
			);
			return {
				name: file,
				content: template,
			};
		})
	);

	// get primary language used in repository
	const { data: languages } = await octokit.request(
		'GET /repos/{owner}/{repo}/languages',
		{
			owner: repository.owner.login,
			repo: repository.name,
		}
	);

	// figure out dominant language used in repository
	let dominantLanguage = '';
	let dominantLanguageBytes = 0;
	for (const language in languages) {
		if (languages[language] > dominantLanguageBytes) {
			dominantLanguage = language;
			dominantLanguageBytes = languages[language];
		}
	}

	if (dominantLanguage === '') {
		throw new Error('Could not determine repository dominant language');
	}

	// come up with branch name based on the current date. remove all spaces, colons, parentheses, and periods
	let branchName = `octoherd/${new Date().toString().replace(/ /g, '-').replace(/:/g, '-').replace(/\(/g, '-').replace(/\)/g, '-').replace(/\./g, '-')}`;

	// only take the first part of branchName before "-GMT"
	branchName = branchName.split('-GMT')[0];

	// lowercase the branchName
	branchName = branchName.toLowerCase();

	let branchCreated = false;
	let PRCreated = false;

	let alertsEnabled = false;
	try {
		// check if vulnerability alerts are enabled for the repository
		const result = await octokit.request('GET /repos/{owner}/{repo}/vulnerability-alerts', {
			owner: repository.owner.login,
			repo: repository.name,
		});
		// if the status code is a 204, then vulnerability alerts are enabled
		alertsEnabled = result.status === 204;
	} catch (err) {
		// if it's a 404 error, that means vulnerability alerts are not enabled
		if (err.status !== 404) {
			throw err;
		}
	}

	// if vulnerability alerts are disabled, enable them
	if (!alertsEnabled) {
		await octokit.request('PUT /repos/{owner}/{repo}/vulnerability-alerts', {
			owner: repository.owner.login,
			repo: repository.name,
		});
	}

	// make sure automated security fixes are enabled
	// note: there's no GET endpoint exposed for this feature so we must set it each time
	await octokit.request('PUT /repos/{owner}/{repo}/automated-security-fixes', {
		owner: repository.owner.login,
		repo: repository.name,
	});

	if (await shouldCreateDependabotPR(octokit, repository)) {
		// get the correct template based on dominant language
		let template = '';
		if (dominantLanguage.toLowerCase() === 'javascript' || dominantLanguage.toLowerCase() === 'typescript') {
			template = 'node.yml';
		} else if (dominantLanguage === 'C#' || dominantLanguage.toLowerCase().includes('csharp') || dominantLanguage.toLowerCase().includes('dotnet') || dominantLanguage.toLowerCase().includes('.net')) {
			template = 'dotnet.yml';
		} else if (dominantLanguage.toLowerCase() === 'go') {
			template = 'go.yml';
		} else if (dominantLanguage.toLowerCase() === 'ruby') {
			template = 'ruby.yml';
		}

		const branch = await createBranch(octokit, repository, branchName);
		branchCreated = true;

		// get template content from file
		if (templates === undefined) {
			octokit.log.error(`could not find templates`);
			return;
		}

		const templateContent = templates.find((t) => t.name === template).content;

		// create commit for dependabot config
		await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
			owner: repository.owner.login,
			repo: repository.name,
			path: `.github/dependabot.yml`,
			message: `feat: add ${dominantLanguage} dependabot config`,
			content: Buffer.from(templateContent).toString("base64"),
			branch: branch.data.ref,
		});

		await openPR(octokit, repository, branch.data.ref,
			`feat: add missing ${dominantLanguage} workflows`,
			`This PR adds missing ${dominantLanguage} workflows to the repository. These may include Dependabot and CodeQL workflows.`);
		PRCreated = true;
	}

	if (await shouldCreateCodeqlPR(octokit, repository)) {

		// get the codeql template from file
		let codeqlTemplate = templates.find((t) => t.name === 'codeql.yml').content;
		let codeqlLanguage = dominantLanguage.toLowerCase();

		if (codeqlLanguage === 'typescript') {
			codeqlLanguage = 'javascript';
		}

		// CodeQL supports [ 'cpp', 'csharp', 'go', 'java', 'javascript', 'python', 'ruby' ]
		// make sure our dominantlanguage is supported by CodeQL
		if (!(['cpp', 'csharp', 'go', 'java', 'javascript', 'python', 'ruby'].includes(codeqlLanguage))) {
			octokit.log.warn(`CodeQL does not support ${dominantLanguage} in repository ${repository.name}`);
			octokit.log.warn(`Skipping CodeQL setup in repository ${repository.name}`);
		}

		// replace the language in the codeql template
		codeqlTemplate = codeqlTemplate.replace('**language**', `${codeqlLanguage}`);

		// if the branch hasn't been created, do so now
		if (!branchCreated) {
			const branch = await createBranch(octokit, repository, branchName);
			branchCreated = true;
		}

		// create commit for codeql template
		await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
			owner: repository.owner.login,
			repo: repository.name,
			path: `.github/workflows/codeql.yml`,
			message: `feat: add codeql workflow`,
			content: Buffer.from(codeqlTemplate).toString("base64"),
			branch: repository.default_branch,
		});

		// if the PR hasn't been created, do so now
		if (!PRCreated) {
			await openPR(octokit, repository, branchName,
				`feat: add missing ${dominantLanguage} workflows`,
				`This PR adds missing ${dominantLanguage} workflows to the repository. These may include Dependabot and CodeQL workflows.`);
			PRCreated = true;
		}
	}
}
