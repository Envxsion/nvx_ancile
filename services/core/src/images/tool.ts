/**
 * ------------------------------------------------------------------
 *  Title    |  image_generate, the image tool
 *  Ref      |  docs/images.md (Generation) · DESIGN.md §5.2
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let a model make a picture with the image provider the
 *           |  person set up, and show it in the thread.
 *  How      |  A built-in tool: the conductor runs it only after the
 *           |  permission gate allowed the call on its real arguments.
 *           |  Action image.generate, resource the provider's URL
 *           |  (http:…), so scopes treat a cloud provider as data
 *           |  leaving the machine and a local one as loopback. GATED
 *           |  by default: it can cost money; config/tools.yaml
 *           |  (tools.image.generate) can change that.
 * ------------------------------------------------------------------
 */

import { AncileError, IMAGE_LIMITS, ImageGenerateArgs } from '@nvx/contracts';
import type { ToolSpec } from '../tools/registry';
import type { ImageService } from './service';

export function imageTool(service: ImageService): ToolSpec {
  return {
    name: 'image_generate',
    get description() {
      return [
        'Make an image from a text prompt with the image provider set up in NVX Ancile, and show it to the person in the thread.',
        'Describe the picture fully in `prompt`. The result names the stored images by id; do not repeat them as links.',
        `Up to ${IMAGE_LIMITS.perCall} images per call.`,
        service.describeProviders(),
        'In a private or local-only notebook only a provider that stays on this computer can be used: name it in `provider`.',
      ].join(' ');
    },
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the image should show, in detail.' },
        size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024', '512x512'] },
        n: { type: 'integer', minimum: 1, maximum: IMAGE_LIMITS.perCall },
        provider: { type: 'string', description: 'A provider id; absent: the default.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    action: 'image.generate',
    tier: 'gated',
    destructive: false,
    timeoutMs: (IMAGE_LIMITS.generateTimeoutS + 10) * 1000,
    source: { kind: 'builtin' },
    resource: (args: unknown) => service.resource(args),
    async execute(raw, ctx) {
      const args = ImageGenerateArgs.safeParse(raw);
      if (!args.success)
        throw new AncileError({
          code: 'image.bad_args',
          title: 'That image_generate call is not valid.',
          hint: `${args.error.issues[0]?.path.join('.') || 'arguments'}: ${args.error.issues[0]?.message ?? 'check the arguments'}`,
          status: 400,
          errorClass: 'permanent',
        });
      return service.generate({ threadId: ctx.scope?.threadId ?? null, args: args.data, signal: ctx.signal });
    },
  };
}
