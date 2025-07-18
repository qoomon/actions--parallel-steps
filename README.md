# Parallel Steps &nbsp; [![starline](https://starlines.qoo.monster/assets/qoomon/actions--parallel-steps)](https://github.com/qoomon/starline)
[![Actions](https://img.shields.io/badge/qoomon-GitHub%20Actions-blue)](https://github.com/qoomon/actions)

With this action, you can run steps in parallel within a GitHub Actions workflow job. 

Under the hood, this action utilize [act](https://github.com/nektos/act).

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
            - uses: actions/checkout@v4
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
          RECIPIENT: ${{ steps.parallel-steps.outputs.greetings--recipient }}
           # or just ${{ steps.parallel-steps.outputs.recipient }}
```

### Outputs
- parallel step outputs:
  - `${{ steps.<step_id>.outputs.<parallel_step_id>--<output_name> }}`
- parallel step outcome:
  - `${{ steps.<step_id>.outputs.<parallel_step_id>--outcome }}`
- parallel step conclusion:
  - `${{ steps.<step_id>.outputs.<parallel_step_id>--conclusion }}`

> [!Note]
> The pre-actions of the parallel steps will be executed as part of the main action of this action.

## Workflow Run Examples
https://github.com/qoomon/actions--parallel-steps/actions/workflows/example.yaml
  
## Development

- run locally
  ```bash
  RUNNER_DEBUG=1 gh act --workflows .github/workflows/example.yaml \
    --platform ubuntu-latest=-self-hosted \
    --local-repository qoomon/actions--parallel-steps@main=$PWD \
    --secret GITHUB_TOKEN="$(gh auth token)"
  ```
