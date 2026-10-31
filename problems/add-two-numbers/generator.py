import random
import sys

V = 10**9


def main():
    seed = int(sys.argv[1])
    mode = sys.argv[2]
    rng = random.Random(seed)

    if mode == "small":
        a, b = rng.randint(-10, 10), rng.randint(-10, 10)
    elif mode == "medium":
        a, b = rng.randint(-(10**5), 10**5), rng.randint(-(10**5), 10**5)
    elif mode == "large":
        a, b = rng.randint(-V, V), rng.randint(-V, V)
    elif mode == "edge":
        cases = [(0, 0), (V, V), (-V, -V), (V, -V)]
        a, b = cases[seed % len(cases)]
    else:
        sys.exit(f"unknown mode: {mode}")

    print(a, b)


main()
