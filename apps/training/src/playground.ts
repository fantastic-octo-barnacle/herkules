export const rustExample = `// A proportional controller with a bounded motor command.
fn control(target: f64, measured: f64, kp: f64) -> f64 {
    (kp * (target - measured)).clamp(-10.0, 10.0)
}

fn main() {
    let mut position = 0.0;
    for step in 0..20 {
        let output = control(1.0, position, 2.0);
        position += output * 0.1;
        println!("t={:.1}s  position={:.3}  output={:.3}",
            step as f64 * 0.1, position, output);
    }
}

#[test]
fn output_stays_within_motor_limits() {
    assert_eq!(control(100.0, 0.0, 2.0), 10.0);
    assert_eq!(control(-100.0, 0.0, 2.0), -10.0);
}
`;
export function playgroundUrl(code: string): string {
  const url = new URL("https://play.rust-lang.org/");
  url.searchParams.set("version", "stable");
  url.searchParams.set("mode", "debug");
  url.searchParams.set("edition", "2024");
  url.searchParams.set("code", code);
  return url.href;
}
