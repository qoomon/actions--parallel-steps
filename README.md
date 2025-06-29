# Parallel Steps &nbsp; [![starline](https://starlines.qoo.monster/assets/qoomon/actions--parallel-steps)](https://github.com/qoomon/starline)
[![Actions](https://img.shields.io/badge/qoomon-GitHub%20Actions-blue)](https://github.com/qoomon/actions)

With this action, you can run parallel steps in a GitHub Actions workflow jobs. Under the hood, this action uses [act](https://github.com/nektos/act).

## Usage

```yaml
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: qoomon/actions--parallel-steps@v1
        id: parallel-steps
        with:
          steps: |
            - run: echo Step0
            - run: echo Step1
            - uses: actions/github-script@v7
              id: greetings
              with:
                script: |
                  const recipient = 'world'
                  console.log(`Hello ${recipient}!`)
                  core.setOutput('recipient', recipient)

      # access parallel steps outputs            
      - run: echo Hello $RECIPIENT
        env:
          RECIPIENT: ${{ steps.parallel-steps.outputs.greetings-recipient }}
```

> [!Note]
> The pre-actions of the parallel steps will be executed as part of the main action of this action.

## Workflow Run Examples
https://github.com/qoomon/actions--parallel-steps/actions/workflows/example.yaml

## Known Issues
- `GITHUB_STEP_SUMMARY` is not supported by latest release of `act`, however the [feature #2759](https://github.com/nektos/act/pull/2761) has be implemented and merged to main branch already. New act version will be released on 1st of July

## Development

- run locally
  ```bash
  RUNNER_DEBUG=1 gh act --workflows .github/workflows/example.yaml \
    --platform ubuntu-latest=-self-hosted \
    --local-repository qoomon/actions--parallel-steps@main=$PWD \
    --secret GITHUB_TOKEN="$(gh auth token)"
  ```
