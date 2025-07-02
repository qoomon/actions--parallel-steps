# Parallel Steps &nbsp; [![starline](https://starlines.qoo.monster/assets/qoomon/actions--parallel-steps)](https://github.com/qoomon/starline)
[![Actions](https://img.shields.io/badge/qoomon-GitHub%20Actions-blue)](https://github.com/qoomon/actions)

With this action, you can run steps in parallel within a GitHub Actions workflow job. 

Under the hood, this action uses [act](https://github.com/nektos/act).

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

      # access step outcomes and conclusions
      - run: |
          echo "Step outcome: ${{ steps.parallel-steps.outputs.greetings--outcome }}"
          echo "Step conclusion: ${{ steps.parallel-steps.outputs.greetings--conclusion }}"
```

### Accessing Step Outcomes and Conclusions

For each step with an `id`, you can access the step's outcome and conclusion:

```yaml
- uses: qoomon/actions--parallel-steps@v1
  id: parallel-scans
  with:
    steps: |
      - id: trivy
        run: trivy scan
      - id: sonar
        continue-on-error: true
        run: sonar-scanner

- run: |
    echo "Trivy outcome: ${{ steps.parallel-scans.outputs.trivy--outcome }}"
    echo "Trivy conclusion: ${{ steps.parallel-scans.outputs.trivy--conclusion }}"
    echo "Sonar outcome: ${{ steps.parallel-scans.outputs.sonar--outcome }}"
    echo "Sonar conclusion: ${{ steps.parallel-scans.outputs.sonar--conclusion }}"

# Use outcomes in conditional steps
- if: ${{ steps.parallel-scans.outputs.trivy--outcome == 'failure' }}
  run: echo "Trivy scan failed"
```

**Outcome and Conclusion Values:**
- `success`: The step completed successfully
- `failure`: The step failed
- `skipped`: The step was skipped or didn't run

> [!Note]
> Currently, `outcome` and `conclusion` return the same values. The `outcome` represents the actual result of the step execution. When using `continue-on-error: true`, the step's outcome will still be `failure` if it fails, allowing you to detect and handle failed steps as shown in the example above.
```

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
