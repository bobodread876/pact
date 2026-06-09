# Pact — Start9 (StartOS) package

The StartOS service package has moved to its own repository (it must live at a
repo root for the StartOS build toolchain + CI):

➡️ **https://github.com/bobodread876/pact-startos**

It wraps the published `ghcr.io/bobodread876/pactd` image, targets
`@start9labs/start-sdk@1.5.3` (StartOS 0.4.0-beta), and builds a signed `.s9pk`.
See that repo's README for build/sideload steps.
