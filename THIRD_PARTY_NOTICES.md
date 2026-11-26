# Third-party notices

TrustPhoto is licensed under the Apache License 2.0 (see `LICENSE`). The files
in this repository are original work of SocialHuman Technologies Oy, except
for the material below.

## Lucide icons

These icons are copied from [Lucide](https://lucide.dev): in
`apps/web/src/icons.ts`, `seal` (Lucide `badge-check`), `camera`, `link`,
`check`, `minus`, `search`, `share` and `info`; the seal in
`apps/web/public/assets/favicon*.svg` and in the app icon
`apps/mobile/assets/icon.png` (`badge-check`). `phone`, `clock` and `image`
are drawn in Lucide's style.

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

Lucide's icons that come from Feather (of those copied here: check, info,
minus, search, share and link) are under the MIT license:

```
The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Platform icons in the app

The phone app shows SF Symbols on iOS and Material Symbols on Android through
`expo-symbols`. The symbols come from the platform and from the
`@expo-google-fonts/material-symbols` package at build time. No symbol file
is stored in this repository. SF Symbols are subject to Apple's license terms
for SF Symbols; Material Symbols are licensed under the Apache License 2.0.

## Algorithms

`packages/shared/src/features.ts` is an original implementation of published
methods: FAST corners (Rosten and Drummond, 2006), the Harris corner measure
(Harris and Stephens, 1988), BRIEF descriptors (Calonder et al., 2010) and
their oriented form from ORB (Rublee et al., 2011).
`packages/shared/src/phash.ts` is an original implementation of the
DCT-based perceptual hash. `packages/shared/src/random.ts` is mulberry32, a
public-domain generator by Tommy Ettinger. No other code was copied from
another implementation.

## Dependencies

The npm packages that this project installs are not part of this repository.
Each keeps its own license (see `package-lock.json` and the packages
themselves). The image library `sharp` loads `libvips`, which is licensed
under the LGPL-3.0-or-later, as a separate shared library.
