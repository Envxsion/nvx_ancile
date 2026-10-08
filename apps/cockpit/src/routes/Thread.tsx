import { useParams } from '@tanstack/react-router';
import { ThreadView } from '../thread/ThreadView';

/** /t/$threadId: one thread, keyed so switching threads resets local state. */
export function ThreadScreen() {
  const { threadId } = useParams({ strict: false });
  if (!threadId) return null;
  return <ThreadView key={threadId} threadId={threadId} />;
}
