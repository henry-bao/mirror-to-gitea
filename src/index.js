const { Octokit } = require('@octokit/rest');
const request = require('superagent');
const { default: PQueue } = require('p-queue');

async function getGithubRepositories(username, token, mirrorPrivateRepositories) {
    const octokit = new Octokit({ auth: token || null });

    const publicRepos = await octokit.paginate('GET /users/:username/repos', { username });
    const publicRepositoriesWithForks = toRepositoryList(publicRepos);

    if (mirrorPrivateRepositories === 'true') {
        const privateRepos = await octokit.paginate('GET /user/repos', {
            visibility: 'private',
            affiliation: 'owner',
        });
        const allRepositoriesWithoutForks = toRepositoryList(privateRepos);
        return filterDuplicates(allRepositoriesWithoutForks.concat(publicRepositoriesWithForks));
    }

    return publicRepositoriesWithForks;
}

function toRepositoryList(repositories) {
    return repositories.map((repo) => ({
        name: repo.name,
        url: repo.clone_url,
        private: repo.private,
    }));
}

function filterDuplicates(array) {
    return array.filter((repo, index, self) => index === self.findIndex((r) => r.url === repo.url));
}

async function getGiteaUserOrOrg(gitea, orgName) {
    const endpoint = orgName ? `/api/v1/orgs/${orgName}` : '/api/v1/user';
    return request
        .get(`${gitea.url}${endpoint}`)
        .set('Authorization', `token ${gitea.token}`)
        .then((response) => ({ id: response.body.id, name: response.body.username }));
}

function isAlreadyMirroredOnGitea(repository, gitea, giteaUser) {
    const requestUrl = `${gitea.url}/api/v1/repos/${giteaUser.name}/${repository}`;
    return request
        .get(requestUrl)
        .set('Authorization', `token ${gitea.token}`)
        .then(() => true)
        .catch(() => false);
}

function mirrorOnGitea(repository, gitea, giteaUser, githubToken) {
    return request
        .post(`${gitea.url}/api/v1/repos/migrate`)
        .set('Authorization', `token ${gitea.token}`)
        .send({
            auth_token: githubToken || null,
            clone_addr: repository.url,
            mirror: true,
            repo_name: repository.name,
            uid: giteaUser.id,
            private: repository.private,
        })
        .then(() => console.log('Mirrored:', repository.name))
        .catch((err) => console.error('Failed to mirror', repository.name, err));
}

async function mirror(repository, gitea, giteaUser, githubToken) {
    if (await isAlreadyMirroredOnGitea(repository.name, gitea, giteaUser)) {
        console.log('Repository is already mirrored:', repository.name);
        return;
    }
    await mirrorOnGitea(repository, gitea, giteaUser, githubToken);
}

async function main() {
    const githubUsername = process.env.GITHUB_USERNAME;
    if (!githubUsername) {
        console.error('No GITHUB_USERNAME specified. Exiting.');
        return;
    }

    const githubToken = process.env.GITHUB_TOKEN;
    const giteaUrl = process.env.GITEA_URL;
    if (!giteaUrl) {
        console.error('No GITEA_URL specified. Exiting.');
        return;
    }

    const giteaToken = process.env.GITEA_TOKEN;
    if (!giteaToken) {
        console.error('No GITEA_TOKEN specified. Exiting.');
        return;
    }

    const mirrorPrivateRepositories = process.env.MIRROR_PRIVATE_REPOSITORIES;
    if (mirrorPrivateRepositories === 'true' && !githubToken) {
        console.error('MIRROR_PRIVATE_REPOSITORIES is set to true but no GITHUB_TOKEN specified. Exiting.');
        return;
    }

    const giteaOrgName = process.env.GITEA_ORG_NAME;

    const githubRepositories = await getGithubRepositories(githubUsername, githubToken, mirrorPrivateRepositories);
    console.log(`Found ${githubRepositories.length} repositories on GitHub`);

    const gitea = { url: giteaUrl, token: giteaToken };
    const giteaUser = await getGiteaUserOrOrg(gitea, giteaOrgName);

    const queue = new PQueue({ concurrency: 4 });
    await queue.addAll(githubRepositories.map((repo) => () => mirror(repo, gitea, giteaUser, githubToken)));
}

main();
