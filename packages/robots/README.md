# Robots

Robot arms that play table tennis, from the robot hall (a walk-mode scene of six arms rallying in
an industrial test hall). Only the Torven arm is here so far: Table Tennis
(`apps/web/src/minigames/table-tennis`) plays against it. Everything is procedural (geometry,
canvas textures), built in metres.

| Arm | Maker and model | What it is |
| --- | --- | --- |
| `sixaxis` | Torven TR-30/1.9 | Signal-orange six-axis arm on a seventh-axis floor track, with a gas-spring balancer, a spherical wrist and a pneumatic gripper holding the paddle on a wedge adapter; controller cabinet, dress pack |

## Layout

- `arms/sixaxis/Arm.tsx`: the arm. Each frame it solves its joints in closed form
  (`kinematics.ts`) so its paddle lands on its driver's target; `trackAt` places its carriage
  when the host doesn't know the target ahead (otherwise it plans it from the rally's targets).
- `layout.ts`: the hall's tables, stations and dimensions (the arm reads its paddle's and its
  station's).
- `shared/`: the driver an arm follows (`station.ts`), the robots' clock (`clock.ts`), the
  paddle, and the geometry, material and texture kits. `rally.ts` is the hall's scripted rally;
  the arm uses its paddle target type.

## Driving an arm

An arm is drawn in its **station frame**: the origin on the floor under the middle of its end of
the table, +X along the table towards the net, +Y up, +Z to the arm's right as it faces the
table; the table's top is at y = 0.76. Each frame (in `useRobotFrame`, priority 0) it puts its
`<Paddle>` on `driver.target`: `position` is the blade's hitting centre and `normal` its face's
normal (either face may meet it). The host moves the target before then.

Table Tennis's `RobotOpponent.tsx` places the station at the far end of its table and sets the
target from `robot.ts`, which moves the paddle in the table's frame (the stroke, holding the ball
and the serve). The arm's reach there is fitted in `bot.ts` (`BOT.reach`) and checked against
`kinematics.ts` by `apps/web/tests/table-tennis-robot.test.ts`.
