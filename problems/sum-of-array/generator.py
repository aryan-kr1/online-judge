import random
import sys

N_MAX = 200000
V = 10**9


def main():
    seed = int(sys.argv[1])
    mode = sys.argv[2]
    rng = random.Random(seed)

    if mode == "single":
        a = [rng.randint(-V, V)]
    elif mode == "small":
        n = rng.randint(1, 10)
        a = [rng.randint(-100, 100) for _ in range(n)]
    elif mode == "medium":
        a = [rng.randint(-(10**6), 10**6) for _ in range(1000)]
    elif mode == "large":
        a = [rng.randint(-V, V) for _ in range(N_MAX)]
    elif mode == "max_positive":
        a = [V] * N_MAX
    elif mode == "max_negative":
        a = [-V] * N_MAX
    else:
        sys.exit(f"unknown mode: {mode}")

    print(len(a))
    print(" ".join(map(str, a)))


main()
