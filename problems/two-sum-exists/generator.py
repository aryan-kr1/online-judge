import random
import sys

N_MAX = 200000
V = 10**9

# (array, target) pairs that catch classic bugs
EDGE_CASES = [
    ([5, 5], 10),  # equal values at two different positions -> YES
    ([5, 6], 10),  # would need the same element twice -> NO
    ([-V, -V], -2 * V),  # extreme values -> YES
    ([V, -V], 0),  # opposite extremes -> YES
]


def even_value(rng):
    return rng.randint(-V // 2, V // 2) * 2


def odd_value(rng):
    return rng.randrange(-V + 1, V, 2)


def pair_sums(a):
    return {a[i] + a[j] for i in range(len(a)) for j in range(i + 1, len(a))}


def make_no(rng, n):
    # all values even, target odd: no pair can ever sum to the target
    a = [even_value(rng) for _ in range(n)]
    return a, odd_value(rng)


def make_yes_random(rng, n, limit):
    a = [rng.randint(-limit, limit) for _ in range(n)]
    i, j = rng.sample(range(n), 2)
    return a, a[i] + a[j]


def make_yes_late(rng, n):
    # the only valid pair sits at the very end, so a naive O(n^2) loop
    # has to do almost all of its work before finding it
    y = even_value(rng)
    x = odd_value(rng)
    fillers = []
    while len(fillers) < n - 2:
        v = even_value(rng)
        if v != y:
            fillers.append(v)
    return fillers + [y, x], x + y


def make_small(rng):
    n = rng.randint(2, 8)
    a = [rng.randint(-10, 10) for _ in range(n)]
    roll = rng.random()
    if roll < 0.4:
        target = rng.choice(sorted(pair_sums(a)))
    elif roll < 0.7:
        target = 2 * rng.choice(a)  # tempts solutions that reuse one element
    else:
        target = rng.randint(-20, 20)
    return a, target


def main():
    seed = int(sys.argv[1])
    mode = sys.argv[2]
    rng = random.Random(seed)

    if mode == "edge":
        a, target = EDGE_CASES[seed % len(EDGE_CASES)]
    elif mode == "small":
        a, target = make_small(rng)
    elif mode == "medium_yes":
        a, target = make_yes_random(rng, 2000, 10**6)
    elif mode == "medium_no":
        a, target = make_no(rng, 2000)
    elif mode == "large_no":
        a, target = make_no(rng, N_MAX)
    elif mode == "large_yes_late":
        a, target = make_yes_late(rng, N_MAX)
    else:
        sys.exit(f"unknown mode: {mode}")

    print(len(a), target)
    print(" ".join(map(str, a)))


main()
