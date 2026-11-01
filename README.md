# SuperDispatch

The scheduler: given a piece of work, who takes it, and where does it run?

SuperDispatch reads work from SuperPipeline and runtimes from AgentPod through their public
APIs, and owns neither one's data. It places work by capability, load and history, and records
every decision with every candidate it considered and why.

## Status

Empty. Created on 2026-11-02. The first slice of scheduling lands in SuperPipeline itself
(reasons on an empty claim, push that respects `requires`, an eligibility read and a
reservation hold). This service comes after that.

## Licence

[Apache-2.0](LICENSE)
