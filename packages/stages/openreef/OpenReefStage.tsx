import ReefStage from '../reef/ReefStage.tsx';

/** openreef: the reef stage without its dome; the dancers are simply underwater. */
export default function OpenReefStage() {
  return <ReefStage dome={false} />;
}
