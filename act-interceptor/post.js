import core from "@actions/core";

const step = core.getInput('step', {required: true});

if (step === 'Post') {
    const stage = 'Post';
    console.log(`__::Interceptor::${stage}::End::`);
}
